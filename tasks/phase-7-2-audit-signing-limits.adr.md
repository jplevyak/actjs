# ADR — Phase 7.2: Audit, signing, limits

> Task: [phase-7-2-audit-signing-limits.md](./phase-7-2-audit-signing-limits.md)
> Plan reference: [PLAN.md § Phase 7c/7d/7e](../PLAN.md#phase-7--production-hardening)

- **Status:** Proposed
- **Date:** _TBD_
- **Decider(s):** _TBD_

## Context

_Three independent operational concerns. They share a phase because
each is small and they're all about "we can operate this safely
in production"._

## Decision

Likely decisions to settle here:

### Audit write transactional with action

- Options: same PG transaction (strict), best-effort, configurable.
- Choice: _TBD_

### S3 mirror

- Options: required, optional, omitted in v1.
- Choice: _TBD_

### Signing default

- Options: required, optional default-on, optional default-off.
- Choice: _TBD_

### Token-bucket implementation

- Options: Lua script in Valkey, in-process per-node, dedicated rate-
  limit service.
- Choice: _TBD_

### Per-class active cap default

- Options: 10k, 100k, unlimited.
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
