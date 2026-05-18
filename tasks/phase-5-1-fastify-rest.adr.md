# ADR — Phase 5.1: Fastify + REST

> Task: [phase-5-1-fastify-rest.md](./phase-5-1-fastify-rest.md)
> Plan reference: [PLAN.md § Phase 5a](../PLAN.md#phase-5--api-surface-fastify)

- **Status:** Proposed
- **Date:** _TBD_
- **Decider(s):** _TBD_

## Context

_The REST surface is the contract the SDK and any non-JS client
target. Schema-first via Zod is locked in PLAN.md; this ADR
captures the lower-level tooling choices and how the OpenAPI
artifact is governed._

## Decision

Likely decisions to settle here:

### Fastify type provider

- Options: `fastify-type-provider-zod`, `zod-to-json-schema`,
  hand-rolled.
- Choice: _TBD_

### OpenAPI snapshot test policy

- Options: fail-on-any-diff, fail only on removed routes, advisory-only.
- Choice: _TBD_

### Idempotency key TTL

- Options: 1 h, 24 h, 7 d.
- Choice: _TBD_

### Problem-detail extension fields

- Options: framework codes only, codes + machine-readable details,
  codes + per-error metadata bag.
- Choice: _TBD_

### Legacy route hosting

- Options: under `/legacy/`, on a different port, behind an
  env flag.
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
