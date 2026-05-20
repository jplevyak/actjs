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

- [x] `src/runtime/host.ts`:
  - [x] `class ActorHost` owns the actor state, mailbox, lifecycle.
  - [x] `activate()` loads snapshot, instantiates, calls
        `onActivate?()`.
  - [x] `deactivate(reason)` drains, force-flushes snapshot, calls
        `onDeactivate?()`.
  - [x] Idle deactivation timer (default 5 min, configurable).

### Mailbox

- [x] `src/runtime/mailbox.ts` — bounded single-consumer queue.
- [x] `call(method, args)` and `tell(type, payload)`.
- [x] Inbox durability (write-before-enqueue; ack on handler
      success; replay un-acked on next activate).
- [x] Backpressure: `mailboxCapacity` per-class (default 1024);
      `call` over cap → `MailboxFullError`; `tell` over cap →
      durable-then-drop with `tellsDropped` counter.

### Snapshot persistence

- [x] Trailing 250 ms debounce (configurable).
- [x] `saveSnapshot` writes through the driver (PG = truth; Valkey
      hot cache).
- [x] `onDeactivate` force-flushes.
- [x] Snapshot stamped with `runningVersion` (the Phase 4.2
      version-policy hook).

### Actor directory (single-node)

- [x] `src/runtime/directory.ts` — `Map<ActorId, ActorHost>`. The
      "weak reference" idea was rejected in favor of explicit
      idle-eviction (cleaner deactivate semantics; documented in
      Phase 3.1 ADR follow-ups).
- [x] `Runtime.tell`/`call` look up via the directory.
- [x] `materializing: Map<ActorId, Promise<ActorHost>>` dedupes
      concurrent first-touch.

### Tests

- [x] Counter: 10k tells, final snapshot reads 10000 across runtime
      restart (`tests/runtime/end-to-end.test.ts`).
- [x] Serial invariant: 20 concurrent calls observe zero overlap.
- [x] Mailbox-full: `call` rejects; `tell` drops + counter increments.
- [x] Crash recovery: failing handler leaves inbox unacked, fresh
      host replays them.
- [x] Idle deactivation timer fires and evicts.

---

## Risks & watch-outs

- [ ] Stream consumer group bookkeeping is easy to get wrong. Test
      explicit failure modes (worker dies before `XACK`, stream
      grows unbounded, consumer-group rebalance) before claiming
      durability.
- [ ] Snapshot debounce can lose recent writes on crash. The inbox
      stream is what saves us — assert that ANY committed mailbox
      turn is recoverable from snapshot + un-acked stream tail.
- [x] Replaced Valkey-Streams consumer-group complexity with plain
      `XADD`/`XRANGE`/`XDEL` (one-consumer model); see the
      valkey-pg driver. Memory driver mirrors with array + acked set.
- [ ] Activation rate cap. _(Deferred to Phase 9 cluster work; ADR
      records "no cap in v1 — trust the operator.")_
- [x] Mailbox doesn't deadlock on handler throws — verified by the
      crash-recovery test (failing handler runs to completion of
      the throw, mailbox proceeds to the next message).
- [x] "Mailbox empty" vs "actor idle": idle timer is reset on every
      mailbox commit AND on every successful tell/call entry; an
      in-flight handler `touch()`es the idle clock before deferring
      to the worker.
