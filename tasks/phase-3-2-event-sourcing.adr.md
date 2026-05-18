# ADR — Phase 3.2: Event-sourced actors

> Task: [phase-3-2-event-sourcing.md](./phase-3-2-event-sourcing.md)
> Plan reference: [PLAN.md § Phase 3a/3b (ES path)](../PLAN.md#phase-3--actor-runtime)

- **Status:** Proposed
- **Date:** _TBD_
- **Decider(s):** _TBD_

## Context

_ES is opt-in but load-bearing for ledger-style actors. Storage was
defined in Phase 2; runtime mailbox in 3.1. This ADR makes the
trade-offs that live below the user-visible API._

## Decision

Likely decisions to settle here:

### Snapshot interval default

- Options: every 50 events, every 100, every 1000.
- Choice: _TBD_

### Floating + ES compatibility

- Options: allowed, forbidden, allowed-with-warning.
- Choice: _TBD_

### Event payload size cap

- Options: 16 KiB, 64 KiB, 1 MiB.
- Choice: _TBD_

### Cold-start reader strategy

- Options: cursor + LIMIT, SERVER-side cursor (`DECLARE CURSOR`),
  streaming `COPY`.
- Choice: _TBD_

### Reduce semantics

- Options: pure function (recommended), async allowed, side effects
  permitted in handlers only.
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
