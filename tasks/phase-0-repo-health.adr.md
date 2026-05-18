# ADR — Phase 0: Repo health & TS conversion

> Task: [phase-0-repo-health.md](./phase-0-repo-health.md)
> Plan reference: [PLAN.md § Phase 0](../PLAN.md#phase-0--repo-health--ts-conversion)

- **Status:** Proposed
- **Date:** _TBD_
- **Decider(s):** _TBD_

## Context

_What forces are at play? Why is a decision needed now? Reference the
phase's goals from PLAN.md and any constraints (existing sketch shape,
target audience, downstream phases that depend on choices made here)._

## Decision

_The choices made for this phase. Each subsection captures one binary
or small-finite-option call that future readers might second-guess._

### Package manager

- Options considered: npm, pnpm, yarn.
- Choice: _TBD_
- Rationale: _TBD_

### TypeScript compiler invocation

- Options considered: `tsc -b`, `tsup` for everything, `swc` build.
- Choice: _TBD_
- Rationale: _TBD_

### Container base image

- Options considered: distroless, alpine, debian-slim, official `node:*`.
- Choice: _TBD_
- Rationale: _TBD_

### Test runner

- Options considered: Vitest, Jest, node:test.
- Choice: _TBD_
- Rationale: _TBD_

### Coverage gate level

- Options considered: no gate, 50%, 80%, 90%.
- Choice: _TBD_
- Rationale: _TBD_

### Lint config strictness

- Options considered: airbnb, standard, recommended-strict, custom thin.
- Choice: _TBD_
- Rationale: _TBD_

## Consequences

_What becomes easier? What becomes harder? What are we now committed to
that we weren't before? What revisits should future phases trigger?_

### Positive

- _TBD_

### Negative / trade-offs

- _TBD_

### Follow-ups for later phases

- _TBD_

## Alternatives considered (and why not)

_Briefly: options that came up but were not picked, with one-line
reasons. Helps future readers understand the road not taken without
having to re-derive it._

- _TBD_

## References

- _Issues, PRs, prior art, external docs that informed this ADR._
