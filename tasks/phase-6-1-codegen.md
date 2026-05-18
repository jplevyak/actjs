# Phase 6.1 — actctl codegen

> Source: [PLAN.md § Phase 6d](../PLAN.md#phase-6--frontend-sdk)
> Decisions: [phase-6-1-codegen.adr.md](./phase-6-1-codegen.adr.md)

## Goal

Generate `.d.ts` bundles and a `manifest.json` from published class
TypeScript source. The SDK packages (6.2, 6.3) consume the output;
client-side type safety depends on this task landing first.

## Done when

- `actctl codegen --target prod` produces `index.d.ts` + `manifest.json`
  in a target directory.
- `--check` mode exits non-zero if the committed artifacts are stale.
- An app in `apps/web` can import a class's handler signatures by
  type, and removing a handler at the BE produces a TS error in the
  FE.
- The generated `manifest.json` matches the sha that the server
  expects when sent as `X-Actjs-Manifest`.

---

## Checklist

### Source acquisition

- [ ] `actctl codegen` accepts a server URL + admin token, or a
      local class directory, or a Postgres connection.
- [ ] Reads each class's latest non-deprecated TS source for the
      target environment (`dev` / `staging` / `prod`).
- [ ] Records source `sha256` per class for incremental builds.

### Type emission

- [ ] Parse each class with `ts-morph` (or the TS compiler API):
  - [ ] Find handlers decorated with `@handler`.
  - [ ] Extract their argument and return types.
  - [ ] For ES classes, extract the `E` type union and the
        `reduce` signature for client-side replay.
- [ ] Emit a single `index.d.ts`:
  - [ ] Per class: `interface <Class>Handlers { method(args): Promise<R> }`.
  - [ ] Per class: `type <Class>State`.
  - [ ] Per ES class: `type <Class>Event` (discriminated union).
  - [ ] Top-level: `const manifest: Manifest = ...` with the resolved
        version map embedded as a typed literal.
- [ ] Emit `manifest.json` with `{ sha256, resolved }`.

### Incremental builds

- [ ] On every run, compute target manifest sha; if it matches the
      `.actctl/last-sha` cache, exit fast unless `--force`.
- [ ] Per-class output cached by source sha; only changed classes
      get re-extracted.

### `--check` mode

- [ ] Generate to a tempdir; diff against committed files.
- [ ] Exit `0` if identical, `1` with a unified diff if not.
- [ ] Integrates into CI as a required check (used by the monorepo
      flow in MONOREPO.md).

### ES reducer export

- [ ] For ES classes, emit a *runtime* helper alongside the types:
      a function the SDK can use to apply events client-side.
- [ ] The helper is generated from the server's TS source so it's
      byte-identical to server `reduce` semantics.
- [ ] Output: `index.runtime.js` (small, tree-shakeable).

### Manifest pin embedding

- [ ] The generated `index.d.ts` exports
      `export const MANIFEST_SHA = '...'`.
- [ ] The SDK build (6.2) reads this and embeds it as the default
      pin.

### Tests

- [ ] Fixture: a synthetic class with handlers + ES events;
      assert exact emitted `.d.ts` matches the committed snapshot.
- [ ] Source `sha256` is stable across machines (same input bytes
      → same output).
- [ ] `--check` reports a diff and a non-zero exit when a handler is
      removed.
- [ ] Incremental build skips unchanged classes (timing-based test
      asserts < N ms when nothing changed).

---

## Risks & watch-outs

- [ ] TS type extraction via the compiler API is finicky;
      generated `.d.ts` quality drifts if upgrades change defaults.
      Pin TS version and lock with snapshot tests.
- [ ] Generic handlers (`<T>(args: T): T`) won't survive type
      extraction cleanly. Document the supported subset; reject
      unsupported shapes at publish time (extend 4.1 validator).
- [ ] ES reducer code generation must produce safe JS; reducers
      using non-portable language features need a clear error.
- [ ] Manifest sha embedded in JS bundles becomes part of the
      bundle's effective version. Cache busting needs to account
      for it (the SDK does, but document it).
- [ ] The "manifest sha" the SDK sends must equal what the resolver
      would compute server-side. Snapshot-test the canonical-JSON
      serializer in both places against the same fixtures.
