# ADR — Phase 3.3: Reminders & migrations

> Task: [phase-3-3-reminders-migrations.md](./phase-3-3-reminders-migrations.md)
> Plan reference: [PLAN.md § Phase 3c/3d/3e](../PLAN.md#phase-3--actor-runtime)

- **Status:** Proposed
- **Date:** _TBD_
- **Decider(s):** _TBD_

## Context

_Three related concerns finishing the runtime. Reminders are
liveness-critical; migrations are durability-critical; hot/cold
activation determines cold-start latency. Choices here close out
Phase 3 and set up Phase 4 to layer the host bridge cleanly._

## Decision

Likely decisions to settle here:

### Reminder dispatcher tick interval

- Options: 10 ms, 100 ms, 1 s.
- Choice: _TBD_

### Reminder durability (Lua pop atomicity)

- Options: Lua-based ZRANGEBYSCORE+ZREM, optimistic re-check, single-
  writer assumption.
- Choice: _TBD_

### Pre-migrate snapshot retention window

- Options: 24 h, 7 d, 30 d.
- Choice: _TBD_

### Migration purity enforcement

- Options: enforce by withholding host APIs, document-only, runtime
  detect-and-warn.
- Choice: _TBD_

### Hot cache TTL

- Options: never (idle eviction only), 1 h, 24 h.
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
