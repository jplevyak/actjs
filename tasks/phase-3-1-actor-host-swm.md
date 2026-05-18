# Phase 3.1 — Actor host: SWM mailbox

> Source: [PLAN.md § Phase 3a/3b](../PLAN.md#phase-3--actor-runtime)
> Decisions: [phase-3-1-actor-host-swm.adr.md](./phase-3-1-actor-host-swm.adr.md)

## Goal

Implement single-writer mailbox semantics for `Actor<S>` classes: one
in-process owner per active actor, serial mailbox, durable inbox
stream, debounced snapshots, lifecycle hooks. ES support and reminders
come in 3.2 and 3.3.

## Done when

- A `Counter` actor receives 10k sequential `increment` `tell`s,
  finishes processing them, and the persisted snapshot reads `10000`
  after process restart.
- `MailboxFull` is observable: a forced overflow returns a structured
  error to the caller (for `call`) or increments a drop counter
  (for `tell`).
- A crash mid-mailbox (kill `-9`) replays unacked inbox entries on
  next activate and converges to the same final state.

---

## Checklist

### `ActorHost` core

- [ ] `src/runtime/host.ts`:
  - [ ] `class ActorHost<S>` owning one `ActorId`'s state, its class
        instance, its mailbox, and a `lastActiveAt` clock.
  - [ ] `activate()` — load snapshot from driver, instantiate class,
        call `onActivate?()`.
  - [ ] `deactivate(reason)` — flush mailbox, persist snapshot, call
        `onDeactivate?()`, mark host idle.
  - [ ] Idle deactivation timer (default 5 min, configurable per
        class).

### Mailbox

- [ ] `src/runtime/mailbox.ts` — bounded async queue, `concurrency:
      1` semantics.
- [ ] Two message types:
  - [ ] `call(method, args)` — returns a `Promise<R>` to the caller;
        resolves with the handler return or rejects on throw.
  - [ ] `tell(type, payload)` — fire-and-forget, no return.
- [ ] Inbox durability:
  - [ ] Every `tell` is written to `actor:<id>:inbox` (Valkey
        stream) *before* the in-memory enqueue.
  - [ ] On handler success, the stream entry is acked (`XACK`
        equivalent).
  - [ ] On activate, replay un-acked stream entries before accepting
        new traffic.
- [ ] Backpressure:
  - [ ] `maxMailbox` per-class (default 1024).
  - [ ] `call` over the cap → `MailboxFull` error (HTTP 429).
  - [ ] `tell` over the cap → dropped + `actor_mailbox_drop_total`
        increment.

### Snapshot persistence

- [ ] Debounce window per actor (default 250 ms after last commit).
- [ ] `saveSnapshot` writes Valkey hot cache and PG (PG is source of
      truth).
- [ ] `onDeactivate` forces a flush.
- [ ] Snapshot also records `class_version` (sticky pin); not used
      yet but the field must be wired so 4.2 doesn't have to revisit.

### Actor directory (single-node)

- [ ] In-memory `Map<ActorId, ActorHost>` with weak-reference idle
      eviction.
- [ ] Routing: a top-level `Runtime.dispatch(envelope)` looks up the
      owner, materializes it if needed, hands the envelope to its
      mailbox.
- [ ] Reservation: keep a `Map<ActorId, Promise<ActorHost>>` so
      concurrent first-touch on a cold actor doesn't double-activate.

### Tests

- [ ] Counter actor: 10k `tell`s, final snapshot correct.
- [ ] Serial invariant: two concurrent `call`s never see overlapping
      handler execution (verified by sleeping inside handler and
      asserting non-overlap timestamps).
- [ ] Mailbox-full: enforce, then drain, then accept new traffic.
- [ ] Crash recovery: kill the process mid-batch; on restart, ack'd
      messages do NOT replay, un-ack'd messages DO replay, final
      state is correct.
- [ ] Idle deactivation: actor with no traffic gets deactivated,
      next `call` re-activates it transparently.

---

## Risks & watch-outs

- [ ] Stream consumer group bookkeeping is easy to get wrong. Test
      explicit failure modes (worker dies before `XACK`, stream
      grows unbounded, consumer-group rebalance) before claiming
      durability.
- [ ] Snapshot debounce can lose recent writes on crash. The inbox
      stream is what saves us — assert that ANY committed mailbox
      turn is recoverable from snapshot + un-acked stream tail.
- [ ] Eager activation under cold load (a burst of 1000 distinct
      actors) can OOM the process. Add an activation rate cap; the
      ADR should pick a number.
- [ ] Handlers can throw at any await point. Make sure the mailbox
      doesn't deadlock when a handler rejects — the next message
      must still progress.
- [ ] Don't conflate "mailbox empty" with "actor idle." Idle is
      time-based; an actor with one in-flight `call` is busy, not
      idle.
