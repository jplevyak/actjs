# ADR — Phase 0: Repo health & TS conversion

> Task: [phase-0-repo-health.md](./phase-0-repo-health.md)
> Plan reference: [PLAN.md § Phase 0](../PLAN.md#phase-0--repo-health--ts-conversion)

- **Status:** Accepted
- **Date:** 2026-05-18
- **Decider(s):** project author

## Context

actjs ships today as a small JavaScript sketch: five `.js` files,
Express 5, the Redis v4 client, and a `demo.bash` driver. PLAN.md
locks TypeScript everywhere as the new floor, and every later phase
expects strict types, a Vitest harness, a Docker-friendly layout,
and CI guardrails to already exist. Phase 0 exists so phases 1–9
never have to relitigate any of that.

Constraints carried in from earlier conversations:

- Single-package today; the SDK packages from Phase 6 will introduce
  a workspace.
- Self-hosted library deployment target, so the operational story
  is "one Node process + Valkey + Postgres," not a SaaS platform.
- Conversion must not regress the existing `demo.bash` integration
  flow.

## Decision

### Package manager — **npm**

The repo already has a `package-lock.json` and only one package.
Switching to pnpm or yarn before there's a workspace adds churn for
no benefit. The workspace transition in Phase 6 is the natural time
to revisit; pnpm is the leading candidate there.

### TypeScript compiler invocation — **`tsc -b` (project references)**

Standard, predictable, and integrates cleanly with editors. `tsup`
arrives in Phase 6 for SDK packages that need bundling for the
browser; engine code stays on plain `tsc`.

### Container base image — **`gcr.io/distroless/nodejs20-debian12`**

No shell, no package manager, smaller attack surface. A commented
`node:20-slim` target stays in the Dockerfile as a debug fallback
since distroless can't `docker exec sh`.

### Test runner — **Vitest**

Locked by PLAN.md (ESM-native, fast, Jest-compatible matchers).

### Coverage gate — **80 / 80 / 70 / 80** (lines / functions / branches / statements)

These are the v1 numbers. As the task notes, the current ~200 lines
of engine will trivially hit them; treat the gate as load-bearing
once Phase 3 lands and meaningful state-machine code exists.

### Lint config — **thin**

`@typescript-eslint/recommended` + `eslint-plugin-import` only. No
airbnb / xo / standard. Prettier handles formatting; ESLint stays
out of formatting opinions.

## Consequences

### Positive

- Lowest-friction starting point: a contributor with Node 20 and
  `npm` runs `npm ci && npm test` and is productive.
- Distroless final image is small (~80 MB) and meaningfully reduces
  attack surface for self-hosters.
- Thin lint config keeps PR review focused on real issues, not
  bikeshed.

### Negative / trade-offs

- npm's install times will look slow once the workspace lands. The
  switch in Phase 6 is then a project-wide ripple, not a local one.
- Distroless requires the commented `node:20-slim` swap when
  diagnosing in a container. Documented in the Dockerfile.
- 80% line coverage on ~200 lines is mostly cosmetic until Phase 3.
  The gate is intentionally trusting the contributor not to game it.

### Follow-ups for later phases

- Phase 6 revisits the package-manager choice when SDK packages
  enter the workspace.
- Phase 8 raises coverage gates once real engine code exists.
- Phase 4 publishes need an Ed25519 signing key story; Phase 0 only
  ships the runtime, not the key generation.

## Alternatives considered (and why not)

- **pnpm now.** Saves the migration later, costs more change now.
  Without a workspace there's nothing to amortize the symlink layout
  against.
- **`tsup` for the engine.** Single-build artifact, but introduces
  a bundler dependency in a place where the standard `tsc` output
  works fine. Defer to Phase 6 where the SDK actually benefits.
- **alpine final image.** Smaller still, but musl libc bites Node
  native modules (`isolated-vm` was a candidate at one point; even
  though we ruled it out, the lesson applies). Distroless on
  glibc is the safer baseline.
- **Jest.** Mature ecosystem, but Jest's ESM story is famously
  rough; Vitest is the modern default.

## References

- PLAN.md § Phase 0
- tasks/phase-0-repo-health.md
- Existing repo: package.json, demo.bash, current `.js` sources
