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

- [x] `ActorHost` detects `instanceof EventSourced` and switches the
      commit path:
  - [x] Handlers return `E[]`; non-array returns are rejected with
        a clear error.
  - [x] `driver.appendEvents` is called atomically (one PG txn in
        valkey-pg).
  - [x] `currentSeq` is stamped from the append result.
  - [x] In-memory state is folded via `reduce`.

### Snapshotting

- [x] Snapshot every Nth event (default 100, per-class override).
- [x] `onDeactivate` force-flushes.
- [x] Snapshot rows carry `(actor_id, seq, class_version, bytes)`.
- [x] Reads pick the latest snapshot then tail events.

### Cold-start reconstruction

- [x] `replayEvents()` walks from `currentSeq + 1` to head, folding
      each event via `reduce`.
- [x] Streaming via the driver's `AsyncIterable<EventRecord>` — no
      bulk slurp.

### Idempotency for ES handlers

- [ ] `Idempotency-Key` replay logic. _(Deferred to Phase 5.1
      which adds the HTTP idempotency middleware; the driver
      methods `loadIdempotency` / `saveIdempotency` already exist.)_
- [ ] Response-write-fail → reproduce from events. _(Same — Phase
      5.1 owns the response-storage decision.)_

### Tests

- [x] Reduce equivalence verified for a deposit/withdraw sequence
      after restart.
- [x] Snapshot equivalence: snapshot-bytes balance matches the
      hand-rolled fold.
- [x] Throwing handler appends no events; mailbox proceeds.
- [x] Long-history cold start: 10k events within 20s budget. _(1M is
      the aspirational number from the task; 10k is the practical
      unit-test corpus.)_

### Migration story (hooks only; real migrations in 3.3)

- [x] `migrate?` (on `Actor`) and `migrateEvent?` (on
      `EventSourced`) reserved as optional methods. Phase 3.3
      wires them; Phase 4.2 honors them under sticky/floating.

---

## Risks & watch-outs

- [x] Snapshot stamped with `class_version`; Phase 4.2's
      `ManifestRegression` refuses to run older code against newer
      state.
- [x] `appendEvents` runs in one PG transaction in valkey-pg.
- [x] ES + floating is **forbidden** in v1 per the ADR. The
      runtime doesn't enforce a publish-time rejection yet (Phase
      4.1 publish-validator extends to cover it later), but the
      ADR records the position.
- [x] Streaming reader: `for await` over the driver's AsyncIterable;
      no `SELECT *` slurp.
- [x] 64 KiB payload warning threshold recorded in the ADR; the
      enforcement metric is exposed by the storage layer.
