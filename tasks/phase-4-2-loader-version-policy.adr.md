# ADR — Phase 4.2: Loader & version policy

> Task: [phase-4-2-loader-version-policy.md](./phase-4-2-loader-version-policy.md)
> Plan reference: [PLAN.md § Phase 4c/4d](../PLAN.md#phase-4--code-versioning)

- **Status:** Proposed
- **Date:** _TBD_
- **Decider(s):** _TBD_

## Context

_The loader produces the executable artifact every user-defined
handler runs from. The host bridge is the only surface user code
sees. The sticky/floating policy decides whose code an actor runs.
All three together define the actjs runtime API forever; deviation
later is expensive._

## Decision

Likely decisions to settle here:

### Module instantiation

- Options: `new Function`, `vm.Module`, dynamic `import()` of
  a file URL, `vm.runInThisContext`.
- Choice: _TBD_

### LRU cap

- Options: 64, 256, 1024 compiled modules per process.
- Choice: _TBD_

### Host bridge exposure model

- Options: parameter named `actjs` only; also bind on `this`;
  global symbol.
- Choice: _TBD_

### Forbidden-import enforcement

- Options: AST lint at publish, runtime `Module._resolveFilename`
  override, accept and document.
- Choice: _TBD_

### ManifestRegression behavior

- Options: hard error, warning + run, server config flag.
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
