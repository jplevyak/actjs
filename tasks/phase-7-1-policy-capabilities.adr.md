# ADR — Phase 7.1: Policy & capabilities

> Task: [phase-7-1-policy-capabilities.md](./phase-7-1-policy-capabilities.md)
> Plan reference: [PLAN.md § Phase 7a/7b](../PLAN.md#phase-7--production-hardening)

- **Status:** Proposed
- **Date:** _TBD_
- **Decider(s):** _TBD_

## Context

_Auth (Phase 5.3) only tells us *who* is making a call. Policy and
capabilities tell us *what* they can do. The framework needs a
pleasant default + an escape hatch to per-class JS._

## Decision

Likely decisions to settle here:

### Policy DSL expression language

- Options: CEL (Google's), JSONata subset, Rhai, hand-rolled, no
  DSL (JS only).
- Choice: _TBD_

### Capability signing key management

- Options: single server key, per-tenant keys, rotated keys with kid
  in JWT.
- Choice: _TBD_

### Revocation cache TTL

- Options: 10 s, 60 s, 5 min.
- Choice: _TBD_

### Default-deny vs default-allow

- Options: default-deny always, default-allow for `Anonymous` ==
  null, configurable.
- Choice: _TBD_

### Capability TTL bounds

- Options: max 24 h, max 7 d, unbounded (caller decides).
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
