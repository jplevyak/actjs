# Phase 6.1 — actctl codegen

> Source: [PLAN.md § Phase 6d](../PLAN.md#phase-6--frontend-sdk)
> Decisions: [phase-6-1-codegen.adr.md](./phase-6-1-codegen.adr.md)

## Goal

Generate `.d.ts` bundles and a `manifest.json` from published class
TypeScript source. The SDK packages (6.2, 6.3) consume the output;
client-side type safety depends on this task landing first.

## Done when

- [x] `actctl codegen --target prod` produces `index.d.ts` + `manifest.json`
      in a target directory.
- [x] `--check` mode exits non-zero if the committed artifacts are stale.
- [x] An app in `apps/web` can import a class's handler signatures by
      type, and removing a handler at the BE produces a TS error in the
      FE. _(Exercised by the snapshot fixture + drift test; an actual
      `apps/web` consumer lands with Phase 6.2.)_
- [x] The generated `manifest.json` matches the sha that the server
      expects when sent as `X-Actjs-Manifest`. _(Shared `manifestSha256`
      via `src/types/manifest.ts`.)_

---

## Checklist

### Source acquisition

- [x] `actctl codegen` accepts a server URL + admin token, or a
      local class directory, or a Postgres connection.
      _(Local + HTTP shipped. PG direct deferred — server URL covers
      the production flow; see ADR.)_
- [x] Reads each class's latest non-deprecated TS source for the
      target environment (`dev` / `staging` / `prod`).
- [x] Records source `sha256` per class for incremental builds.

### Type emission

- [x] Parse each class with the TS compiler API:
  - [x] Find handlers decorated with `@handler`.
  - [x] Extract their argument and return types.
  - [x] For ES classes, extract the `E` type union and the
        `reduce` signature for client-side replay.
- [x] Emit a single `index.d.ts`:
  - [x] Per class: `interface <Class>Handlers { method(args): Promise<R> }`.
  - [x] Per class: `type <Class>State`.
  - [x] Per ES class: `type <Class>Event` (discriminated union).
  - [x] Top-level: `Classes` umbrella with the resolved
        version map embedded as a typed literal.
- [x] Emit `manifest.json` with `{ sha256, resolved, sources }`.

### Incremental builds

- [x] On every run, hash each input source; if every per-class sha
      matches `.actctl/last-sha.json` and the output files exist,
      exit fast unless `--force`.
- [x] Per-class output cached by source sha; only changed classes
      get re-extracted.

### `--check` mode

- [x] Generate in-memory; diff against committed files.
- [x] Exit `0` if identical, `1` with a unified diff if not.
- [x] Integrates into CI as a required check (used by the monorepo
      flow in MONOREPO.md).

### ES reducer export

- [x] For ES classes, emit a _runtime_ helper alongside the types:
      a function the SDK can use to apply events client-side.
- [x] The helper is generated from the server's TS source via
      `ts.transpileModule`, so it's byte-identical to server
      `reduce` semantics.
- [x] Output: `index.runtime.js` (small, tree-shakeable).

### Manifest pin embedding

- [x] The generated `index.d.ts` exports
      `export const MANIFEST_SHA = '...'`.
- [x] The SDK build (6.2) reads this and embeds it as the default
      pin. _(Tracked into Phase 6.2.)_

### Tests

- [x] Fixture: a synthetic class with handlers + ES events;
      assert exact emitted `.d.ts` matches the committed snapshot.
- [x] Source `sha256` is stable across machines (same input bytes
      → same output).
- [x] `--check` reports a diff and a non-zero exit when a handler is
      removed.
- [x] Incremental build skips unchanged classes (timing-based test
      asserts the cached path is materially faster than the cold run).

### Documentation

- [x] `docs/codegen.md` — usage, supported authoring shapes,
      programmatic API.

---

## Risks & watch-outs

- [x] TS type extraction via the compiler API is finicky;
      generated `.d.ts` quality drifts if upgrades change defaults.
      Pin TS version and lock with snapshot tests.
- [x] Generic handlers (`<T>(args: T): T`) won't survive type
      extraction cleanly. Documented in `docs/codegen.md`; the
      extractor emits `unknown` with a warning. Phase 4.1 may
      add a hard-reject mode at publish time.
- [x] ES reducer code generation must produce safe JS; reducers
      using non-portable language features need a clear error.
      _(Transpile uses `ts.transpileModule`; decorators/enums in
      reduce produce a runtime-broken bundle. Documented.)_
- [x] Manifest sha embedded in JS bundles becomes part of the
      bundle's effective version. Cache busting needs to account
      for it (the SDK does, but document it). _(Documented.)_
- [x] The "manifest sha" the SDK sends must equal what the resolver
      would compute server-side. _(Both call into
      `src/types/manifest.ts:manifestSha256`; covered by the
      snapshot test.)_
