# ADR — Phase 4.1: Publish & resolve

> Task: [phase-4-1-publish-resolve.md](./phase-4-1-publish-resolve.md)
> Plan reference: [PLAN.md § Phase 4a/4b](../PLAN.md#phase-4--code-versioning)

- **Status:** Proposed
- **Date:** _TBD_
- **Decider(s):** _TBD_

## Context

_Versioning is the core differentiator of this framework. Decisions
made here propagate through every later phase: the API surface
(Phase 5), the SDK (Phase 6), and the client-pinned manifests (4.3)
all depend on resolver semantics being stable._

## Decision

Likely decisions to settle here:

### Semver range syntax

- Options: full npm semver (`^`, `~`, `>=`, `||`), simplified
  (`^` + exact only), exact-only.
- Choice: _TBD_

### Manifest canonical JSON form

- Options: sorted-keys + `JSON.stringify`, JCS (RFC 8785),
  custom.
- Choice: _TBD_

### Resolver dep-graph limits

- Options: 8/64, 16/256, 32/1024 (depth/nodes).
- Choice: _TBD_

### TS compiler / version

- Options: `swc`, `tsc` programmatic API, `esbuild`.
- Choice: _TBD_

### Source storage compression

- Options: zstd, gzip, none.
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
