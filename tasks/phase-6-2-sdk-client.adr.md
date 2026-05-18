# ADR — Phase 6.2: @actjs/client SDK

> Task: [phase-6-2-sdk-client.md](./phase-6-2-sdk-client.md)
> Plan reference: [PLAN.md § Phase 6a](../PLAN.md#phase-6--frontend-sdk)

- **Status:** Proposed
- **Date:** _TBD_
- **Decider(s):** _TBD_

## Context

_The framework-agnostic client is what the React and Svelte
bindings (6.3) wrap. Its API and reconnect/offline behavior set
the shape of every consumer's data layer._

## Decision

Likely decisions to settle here:

### Reconnect strategy

- Options: full-jitter exponential (Recommended), fixed, no
  reconnect (caller handles).
- Choice: _TBD_

### Offline persistence default

- Options: IndexedDB on by default, in-memory only, opt-in.
- Choice: _TBD_

### Optimistic update library

- Options: Immer, structural sharing by hand, none.
- Choice: _TBD_

### Bundle format

- Options: ESM only, dual ESM/CJS, single UMD-style.
- Choice: _TBD_

### Browser support matrix

- Options: evergreen only, last-2-versions, includes Safari 14.
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
