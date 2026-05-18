# ADR — Phase 1: Domain model & types

> Task: [phase-1-domain-model.md](./phase-1-domain-model.md)
> Plan reference: [PLAN.md § Phase 1](../PLAN.md#phase-1--domain-model--types)

- **Status:** Proposed
- **Date:** _TBD_
- **Decider(s):** _TBD_

## Context

_What the type system has to support: SWM + ES + Replica actors,
manifest pinning, the legacy shim, and end-to-end type generation
into the SDK. Reference any constraints from Phase 0 (decorators
flavor, target ES version)._

## Decision

Likely decisions to settle here:

### Decorator flavor

- Options: TC39 stage-3, TypeScript legacy `experimentalDecorators`.
- Choice: _TBD_
- Rationale: _TBD_

### Branding strategy

- Options: structural brand (intersection with `{ __brand: ... }`),
  nominal newtype via a private symbol, runtime tag.
- Choice: _TBD_
- Rationale: _TBD_

### UUID library

- Options: `uuidv7`, `uuid` (with v7 support), hand-rolled.
- Choice: _TBD_
- Rationale: _TBD_

### Legacy-shim sunset

- Options: 6 months, 12 months, indefinite.
- Choice: _TBD_
- Rationale: _TBD_

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
