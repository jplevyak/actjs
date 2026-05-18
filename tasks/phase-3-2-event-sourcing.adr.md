# ADR — Phase 3.2: Event-sourced actors

> Task: [phase-3-2-event-sourcing.md](./phase-3-2-event-sourcing.md)
> Plan reference: [PLAN.md § Phase 3a/3b (ES path)](../PLAN.md#phase-3--actor-runtime)

- **Status:** Accepted
- **Date:** 2026-05-18
- **Decider(s):** project author

## Context

Event-sourced actors are an opt-in mode of the Phase 3.1 runtime.
The mailbox / inbox / lifecycle machinery is identical; the
divergence is in what "commit a turn" means:

- SWM actors mutate `state` directly and the host snapshots the
  result on a trailing 250 ms debounce.
- ES actors return `E[]` from their handlers; the host appends those
  events atomically through `driver.appendEvents`, folds them into
  state via the user-defined `reduce`, and snapshots every N events.

The base classes (`Actor<S>`, `EventSourced<S, E>`) are already in
place from Phase 1. The storage primitives (`appendEvents`,
`readEvents`, `headEventSeq`) are already in place from Phase 2.
This ADR fills in the runtime-level policy choices.

## Decision

### Snapshot interval — **every 100 events, per-class overridable**

`snapshotEveryNEvents` config on each class registration. 100 is
the v1 default — cheap enough that cold-start replay never
exceeds a few hundred events, expensive enough that hot ES actors
don't write a snapshot per turn. Operators tune by workload.

### Snapshot-on-deactivate — **always**

The idle deactivation path force-flushes regardless of the event
counter. Combined with the inbox replay from 3.1, this means an
ES actor that's been deactivated and re-activated converges to the
same state on cold restart as on the second activation.

### Floating + ES — **forbidden in v1**

A class that is both `floating: true` and `eventSourced: true` would
need every historical event to be migrated to the latest schema on
cold-start replay. Phase 3.3 lays down `migrateEvent`, but combining
floating with ES turns every cold start into a full migration pass.
Out of scope until there's a use case.

The publish API (Phase 4.1) rejects the combination; for Phase 3.2
the runtime asserts on activate.

### Event payload size cap — **64 KiB per event**

Above this, `appendEvents` should fail (or warn loudly). For v1 we
warn via a metric `event_oversized_total{class}`; rejection lands
when there's evidence operators want it.

### Cold-start reader — **streaming via `driver.readEvents`**

Apply `reduce` event-by-event from the AsyncIterable. State stays
in memory throughout; events do not. Memory usage is O(state) not
O(events).

### Reduce purity — **enforced by API, not by runtime**

`reduce(state, event)` receives no host bridge, no host state
beyond `state`, no `actjs.*` access. Documented contract; runtime
does not sandbox. A pure-failure mode (handler throws inside
reduce) takes down the actor on cold-start replay — easier to
debug than silently-wrong state.

### Snapshot compaction on activate — **opportunistic**

If activation replays at least `snapshotEveryNEvents` events from
the log, the host writes a fresh snapshot before opening to new
traffic. Cost: one extra snapshot write per such activation.
Benefit: every subsequent cold start is fast.

## Consequences

### Positive

- The ES path reuses Phase 3.1's mailbox / inbox / lifecycle
  unchanged. The diff in `ActorHost` is small and localized.
- Replay is one driver primitive (`readEvents` AsyncIterable) the
  conformance suite already exercises.
- Opportunistic snapshot-on-activate naturally trims long histories
  over time without an external compaction job.

### Negative / trade-offs

- The 100-event default is a guess. Some workloads will want 10;
  some will want 10k. Per-class override is mandatory in real use.
- Forbidding `floating + ES` cuts off a real-but-rare use case.
  Phase 3.3 + Phase 4.4 can reopen it with a careful migration
  contract.
- Snapshot-on-activate biases cold starts to be slightly slower
  the first time after long quiet periods; subsequent activations
  benefit. Net positive but worth flagging in the runbook.

### Follow-ups for later phases

- Phase 3.3 wires `migrateEvent` so a class upgrade can transform
  historical events on cold-start replay.
- Phase 4.1 publish validator enforces `!(floating && eventSourced)`.
- Phase 5.2 `actor.subscribe` for ES classes streams events directly
  (not patches); the host needs to fan out events as they're
  appended.
- Phase 6.1 codegen emits client-side reducers from server source
  so subscribers reach the same state by construction.

## Alternatives considered (and why not)

- **Time-based snapshots for ES.** Doesn't match the workload
  shape: ES actors append in bursts. Event-count is the natural
  unit; SWM stays time-based because mutations are time-clustered.
- **Always replay from the beginning of history.** Simple, fits
  pure event-sourcing dogma, scales terribly. Snapshots are
  necessary; the question is only how often.
- **Reject empty event lists.** Tempting (a handler with no
  effects is suspicious), but read-only ES handlers are useful
  (`@handler('balance') balance(): LedgerEvent[] { return []; }`
  returns no events but doesn't bump seq). Allow.
- **Reduce can be async.** Pushes I/O into a pure-fold contract.
  No upside, big downside. Forbid.

## References

- PLAN.md § Phase 3a/3b
- tasks/phase-3-2-event-sourcing.md
- Phase 3.1 implementation (`src/runtime/host.ts`)
- Phase 2 conformance scenarios for `appendEvents` / `readEvents`
