# ADR — Phase 3.1: Actor host (SWM mailbox)

> Task: [phase-3-1-actor-host-swm.md](./phase-3-1-actor-host-swm.md)
> Plan reference: [PLAN.md § Phase 3a/3b](../PLAN.md#phase-3--actor-runtime)

- **Status:** Proposed
- **Date:** _TBD_
- **Decider(s):** _TBD_

## Context

_The SWM runtime is the hot path for everything except ES actors.
Latency and correctness here dominate the system's user-visible
behavior. Decisions made now bind 3.2, 3.3, and the cluster work in
9._

## Decision

Likely decisions to settle here:

### Mailbox implementation

- Options: `p-queue`, hand-rolled async iterator, `Promise` chain.
- Choice: _TBD_

### Inbox stream durability semantics

- Options: write-before-enqueue (durable, slower), write-after-ack
  (faster, replay only on detected loss).
- Choice: _TBD_

### Idle deactivation timer default

- Options: 60 s, 5 min, 30 min.
- Choice: _TBD_

### Snapshot debounce window

- Options: 100 ms, 250 ms, 1 s.
- Choice: _TBD_

### Activation rate cap

- Options: none, 100/s/process, 1000/s/process.
- Choice: _TBD_

## Consequences

### Positive
- _TBD_

### Negative / trade-offs
- _TBD_

### Follow-ups for later phases
- _TBD_

## Alternatives considered (and why not)

- _TBD_

## References

- _TBD_
