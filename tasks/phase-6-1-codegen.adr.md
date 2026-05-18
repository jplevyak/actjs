# ADR — Phase 6.1: actctl codegen

> Task: [phase-6-1-codegen.md](./phase-6-1-codegen.md)
> Plan reference: [PLAN.md § Phase 6d](../PLAN.md#phase-6--frontend-sdk)

- **Status:** Proposed
- **Date:** _TBD_
- **Decider(s):** _TBD_

## Context

_Codegen is the bridge between server-side class source (Phase 4)
and client-side type safety (Phases 6.2, 6.3). It is also the
artifact CI checks. Decisions here affect every PR touching a class._

## Decision

Likely decisions to settle here:

### Type extraction library

- Options: `ts-morph`, TS compiler API directly, `typescript-rtti`,
  `tsc --emitDeclarationOnly` post-processing.
- Choice: _TBD_

### Output target shape

- Options: single big `.d.ts`, per-class files + barrel, npm package.
- Choice: _TBD_

### Supported handler shape restrictions

- Options: no generics, generics with explicit constraints, full TS.
- Choice: _TBD_

### Reducer codegen strategy

- Options: re-emit TS as JS via swc, inline the source string,
  reference the original .ts and let the consumer's bundler resolve.
- Choice: _TBD_

### Cache directory

- Options: `.actctl/` in repo root, `.cache/actctl/`, `node_modules/.cache`.
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
