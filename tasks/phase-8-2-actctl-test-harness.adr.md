# ADR — Phase 8.2: actctl & test harness

> Task: [phase-8-2-actctl-test-harness.md](./phase-8-2-actctl-test-harness.md)
> Plan reference: [PLAN.md § Phase 8b/8c](../PLAN.md#phase-8--observability--dx)

- **Status:** Proposed
- **Date:** _TBD_
- **Decider(s):** _TBD_

## Context

_actctl is the day-to-day operator interface; the test harness is
the day-to-day developer interface. Both shape adoption more than
any feature behind them._

## Decision

Likely decisions to settle here:

### CLI framework

- Options: `commander`, `clipanion`, `oclif`, hand-rolled.
- Choice: _TBD_

### Config format

- Options: TOML, JSON, JS module.
- Choice: _TBD_

### Hot-reload publish semantics

- Options: each save → new pre-release, batched debounce, manual
  trigger.
- Choice: _TBD_

### Assertion style for `@actjs/test`

- Options: Jest-compatible matchers, Vitest-native, framework-
  agnostic.
- Choice: _TBD_

### Time control API

- Options: `advanceTime(ms)`, fake-timer install, both.
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
