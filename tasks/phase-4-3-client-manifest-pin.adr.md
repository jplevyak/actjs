# ADR — Phase 4.3: Client-pinned manifests

> Task: [phase-4-3-client-manifest-pin.md](./phase-4-3-client-manifest-pin.md)
> Plan reference: [PLAN.md § Phase 4e](../PLAN.md#4e-client-pinned-manifests)

- **Status:** Proposed
- **Date:** _TBD_
- **Decider(s):** _TBD_

## Context

_Pinned manifests are the user-visible mechanism for "old clients
keep working after a backend upgrade." The observability side
(`clients_by_manifest`) lets operators answer "is it safe to delete
this class version yet?" — without it, deprecation never finishes._

## Decision

Likely decisions to settle here:

### Header name

- Options: `X-Actjs-Manifest`, `Actjs-Manifest`, `Manifest`.
- Choice: _TBD_

### Default grace window

- Options: 30, 90, 180 days.
- Choice: _TBD_

### Pin observability sampling

- Options: every request, 1/100, 1/1000, time-decayed sketch.
- Choice: _TBD_

### Top-N gauge cap

- Options: 32, 128, 512 shas.
- Choice: _TBD_

### Hard-delete policy

- Options: never (grace forever; only soft-delete), allowed once
  `in-use=0`, admin override.
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
