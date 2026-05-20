# ADR — Phase 6.1: actctl codegen

> Task: [phase-6-1-codegen.md](./phase-6-1-codegen.md)
> Plan reference: [PLAN.md § Phase 6d](../PLAN.md#phase-6--frontend-sdk)

- **Status:** Accepted
- **Date:** 2026-05-20
- **Decider(s):** John Plevyak

## Context

Codegen is the bridge between server-side class source (Phase 4)
and client-side type safety (Phases 6.2, 6.3). It is also the
artifact CI checks. Decisions here affect every PR touching a
class.

The shipped pipeline:

```
sources (local dir | http) → extract (TS compiler API)
                          → emit  (index.d.ts | manifest.json | runtime.js)
                          → cache (.actctl/last-sha.json)
```

The CLI entry point is `actctl codegen`; the same pipeline is
exposed programmatically via `import { run } from 'actjs/codegen'`.

## Decision

### Type extraction library — **TypeScript compiler API, no type checker**

We use `ts.createSourceFile` to produce an AST and walk it
syntactically. No `ts.Program`, no `ts.TypeChecker`, no `ts-morph`.

Reasons:

- **Determinism.** The output depends only on the input source
  bytes plus the pinned `typescript` package. No `tsconfig.json`,
  no `@types/*`, no node_modules resolution = same input always
  produces the same output. This is the property the
  byte-snapshot test guards.
- **Speed.** Skipping the checker drops cold-start codegen on the
  fixture set from ~2 s to ~50 ms.
- **One dependency.** `typescript` is already in `dependencies`
  for the publisher's syntax check. Adding `ts-morph` would
  double the install cost for a one-shot tool.

Rejected:

- **ts-morph.** Nicer API, much slower, larger install.
- **`tsc --emitDeclarationOnly` post-processing.** Would require
  a complete tsconfig and full type resolution; defeats the
  determinism goal.
- **`typescript-rtti`.** Decorator-based reflection requires
  authoring changes to every class; unacceptable.

### Output target shape — **single big `.d.ts` + manifest + runtime**

Three files in the output directory:

- `index.d.ts`: per-class types + `Classes` umbrella + `MANIFEST_SHA`.
- `manifest.json`: sha + resolved + per-class source shas.
- `index.runtime.js`: ES reducers, ESM exports.

We rejected per-class files because the SDK imports a single
`Classes` umbrella; splitting into one-file-per-class adds barrel
maintenance for no consumer benefit. Re-exporting via a package
(`@actjs/types`) is left to consumers who want it — codegen
produces a directory, not a publishable package.

### Supported handler shape restrictions — **structural-only TypeScript**

The extractor copies the **literal source text** of:

- `<State>` and `<Event>` type-argument positions in the
  `extends` clause.
- The first parameter's type annotation on each `@handler` method.
- The method's return type, peeled of one `Promise<…>` wrapper.

It does **not**:

- Resolve imports.
- Inline generic constraints.
- Run TS inference for inferred return types.

Generic handlers (`<T>(args: T): T`) are emitted as `unknown` with
a warning. Inferred return types become `unknown`. This is the
trade-off for the determinism win above; the warning surfaces to
the user, and the publish validator (Phase 4.1) is the natural
place to tighten the rule if we want hard rejection.

Locally declared type aliases (e.g. `type LedgerEvent = …` in the
same file) are inlined into the output so the generated `.d.ts`
is self-contained. Aliases imported from other modules pass
through as identifiers — they won't compile on the client unless
the consumer has the same alias available.

### Reducer codegen strategy — **`ts.transpileModule` per reducer**

ES reducers are emitted into `index.runtime.js` by wrapping the
literal `reduce` method body in a top-level arrow expression and
running `ts.transpileModule` on it. The arrow is then extracted
and inlined into the `reducers` object.

Reasons:

- Byte-identical semantics: the transpiled JS goes through the
  same TS lowering the server uses (Phase 4.2's loader). Floating
  precision, string comparison order, all preserved.
- No new dependency: TS is already pinned.
- Tree-shakeable: the `reducers` object is `Object.freeze`'d, and
  the helper is a single named export.

Rejected:

- **swc / esbuild.** Adds a 2nd transpiler with subtly different
  semantics (different ES default lowerings, different helper
  injection).
- **Inline as a string + `new Function`.** Loses tree-shaking
  and CSP-friendliness.
- **Reference the original `.ts` and let the consumer bundle.**
  Requires the consumer to ship a TS toolchain just to load
  reducers; not all clients have that.

### Cache directory — **`.actctl/` under `--root`**

`<root>/.actctl/last-sha.json` holds the manifest sha and
per-class source shas. The runner appends `.actctl/` to a sibling
`.gitignore` on first run if one exists.

We rejected `node_modules/.cache` (Vite-style) because not every
consumer treats node_modules as a cache, and rejected
`~/.cache/actctl` because cross-machine determinism is part of
the contract — anyone with the source bytes should produce the
same output without consulting a per-user cache.

### Source acquisition — **local + HTTP, no PG direct**

Two source kinds ship in this phase:

- `local:<dir>` — reads every `*.ts` file in the directory,
  treats the basename as the class name. A sibling
  `<class>.meta.json` may supply the version (default
  `0.0.0-local`).
- `http(s)://<base-url>` — talks to a running actjs server,
  picks the latest non-deprecated version per class.

Direct Postgres acquisition is deferred. The production path is
"point at the server you already deploy"; offline-PG queries are
an ops tool for later phases.

## Consequences

### Positive

- Generated artifacts are byte-deterministic per input bytes,
  enabling CI snapshot checks and PR-time drift reporting.
- One dependency (`typescript`) instead of multiple — small bin
  size, fast install.
- Same pipeline used by the CLI and by programmatic callers.
- ES reducers run byte-identically on client and server by
  construction.

### Negative / trade-offs

- Generic handlers and inferred return types lose precision. The
  authoring guide in `docs/codegen.md` lists the supported subset.
- Local source mode is limited to the rough "one .ts per class"
  layout — projects with monorepo-style class folders will need
  a glue script (or to publish via the HTTP path).
- Reducer transpile uses TS — adopting a different reducer
  language later (e.g. AssemblyScript) would require a second
  emitter path.
- The cache key is per-class source sha. Renaming a class without
  changing its content invalidates the cache by class-name
  identity but not by per-class sha; the fast path still works
  because the per-class shas don't match the cached set.

### Follow-ups for later phases

- **Phase 6.2 (`@actjs/client`):** consume `MANIFEST_SHA` as the
  default pin sent on every request.
- **Phase 6.3 (React/Svelte):** consume `Classes` umbrella for
  hook typing.
- **Phase 4.1 (publish validator):** add a `strict-codegen` mode
  that rejects handlers with generic type parameters or inferred
  return types at publish time.
- **Direct Postgres source.** Land if/when an operator asks for
  offline codegen; the loader interface is already pluggable.

## Alternatives considered (and why not)

- **Single-package npm publish (e.g. `@actjs/types`)** —
  premature; consumers may want to wrap the artifact in their
  own monorepo package, which is one path-mapping line away.
- **JSON-Schema instead of TypeScript types** — loses
  expressiveness for discriminated unions and TS template
  literal types that real handlers use.
- **Embed manifest sha in `manifest.json` only, not in `.d.ts`** —
  the SDK build (Phase 6.2) needs the sha at bundle time, before
  it can read JSON; making it a TS constant lets the bundler
  inline it.

## References

- [docs/codegen.md](../docs/codegen.md) — usage guide.
- [src/codegen/](../src/codegen/) — implementation.
- [src/cli/actctl.ts](../src/cli/actctl.ts) — CLI entry point.
- [src/types/manifest.ts](../src/types/manifest.ts) — canonical
  sha computation, shared with the server.
- [tests/codegen/codegen.test.ts](../tests/codegen/codegen.test.ts) —
  fixture snapshot, --check drift, incremental skip tests.
