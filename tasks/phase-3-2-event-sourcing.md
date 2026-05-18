# Phase 3.2 — Event-sourced actors

> Source: [PLAN.md § Phase 3a/3b (ES path)](../PLAN.md#phase-3--actor-runtime)
> Decisions: [phase-3-2-event-sourcing.adr.md](./phase-3-2-event-sourcing.adr.md)

## Goal

Implement the `EventSourced<S, E>` path: handlers return events, the
runtime appends them atomically, state is `reduce(state, event)`, and
periodic snapshots compress cold-start time. Builds on 3.1's mailbox.

## Done when

- A `Ledger` ES actor processes a sequence of `Deposit`/`Withdraw`
  handlers; its `balance` derived from `reduce` matches a hand
  computation.
- Cold-start of an ES actor with N events and a snapshot at seq M
  reads `[snapshot]` + `[events from M+1 to N]` and reconstructs the
  same state.
- A handler that returns `[]` (no events) does not bump seq and does
  not write to the event log.
- A handler that throws aborts the turn: no events appended, mailbox
  proceeds to next message.

---

## Checklist

### Runtime hook

- [ ] `ActorHost` detects `instanceof EventSourced` and switches the
      commit path:
  - [ ] Handler return type narrowed to `E[]`.
  - [ ] After handler returns, runtime calls
        `driver.appendEvents(id, events)` in one PG transaction.
  - [ ] Returned `{ seq }` is stamped onto the host's `currentSeq`.
  - [ ] In-memory state is updated by calling `reduce(state, e)` for
        each new event.

### Snapshotting

- [ ] Snapshot every Nth event (default 100, per-class override).
- [ ] On `onDeactivate`, snapshot regardless of N.
- [ ] Snapshot row records `(actor_id, seq, class_version, bytes)`.
- [ ] Reads load the latest snapshot row, then tail events with
      `seq > snapshot.seq`.

### Cold-start reconstruction

- [ ] `loadEventSourced(id)`:
  - [ ] Load latest snapshot (or `initialState()` if none).
  - [ ] Stream events from `snapshot.seq + 1` to head.
  - [ ] Apply `reduce` in order.
  - [ ] Set `currentSeq = head`.
- [ ] Streaming reader for very long histories (don't slurp millions
      of events into memory at once).

### Idempotency for ES handlers

- [ ] If `Idempotency-Key` is set and the key was already processed,
      _replay_ the stored response without re-emitting events.
- [ ] If the handler ran but the response write failed, the next
      retry must see the events but produce the same response (the
      response is derived from events).

### Tests

- [ ] Ledger property tests:
  - [ ] Any interleaving of valid deposit/withdraw events produces a
        non-negative balance (with rules enforced in handlers).
  - [ ] `reduce(initialState, [...events])` is order-sensitive and
        deterministic.
- [ ] Snapshot equivalence: state at `seq=N` from snapshot+tail
      equals state from `initialState + reduce(all events)`.
- [ ] Handler-throws-on-third-event: only first two events persist.
- [ ] Long-history simulation: 1M events, cold-start time bounded by
      the snapshot interval, not by total events.

### Migration story (hooks only; real migrations in 3.3)

- [ ] Reserve `migrate(prevSnap, prevVer)` and `migrateEvent(event,
prevVer)` slots on `EventSourced` — empty no-ops in this
      phase, wired by 3.3.

---

## Risks & watch-outs

- [ ] Snapshots that don't match the schema of `initialState()`
      cause silent reduce errors. Stamp the snapshot with
      `class_version` and refuse to load if it disagrees with what
      Phase 4 says is current.
- [ ] `appendEvents` must be one PG transaction or it's not really
      event-sourced. Don't be tempted to write events one at a time.
- [ ] If a class has `floating: true` (Phase 4) AND ES, every event
      may have been authored under a different code version. The
      ADR should explicitly call out whether ES + floating is
      supported in v1 (recommend: no).
- [ ] Cold-start streaming reads can pin PG resources. Cursor + LIMIT
      pagination; don't open one giant `SELECT`.
- [ ] Event payloads can grow without bound (large blobs in `payload`
      jsonb). Add a configurable per-event size cap and document it.
