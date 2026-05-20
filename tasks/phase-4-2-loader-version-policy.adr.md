# ADR — Phase 4.2: Loader & version policy

> Task: [phase-4-2-loader-version-policy.md](./phase-4-2-loader-version-policy.md)
> Plan reference: [PLAN.md § Phase 4c/4d](../PLAN.md#phase-4--code-versioning)

- **Status:** Accepted
- **Date:** 2026-05-18
- **Decider(s):** project author

## Context

Phase 4.1 publishes class source to durable, content-addressed
storage. Phase 4.2 makes that source runnable: a class loader that
fetches, compiles, and caches constructors; a host bridge that
gives handlers `actjs.call / tell / scheduleAt / now / log`; and
the sticky-vs-floating version policy that decides which version
an actor's next activation runs.

Constraints carried in:

- Phase 1 base classes (`Actor<S>`, `EventSourced<S, E>`, `Replica<S>`,
  `@handler`) are the only surface user code references in
  published source.
- Phase 4.1 stores raw TypeScript source bytes in `class_blob`;
  the loader compiles them at runtime.
- Phase 3 unit tests register class constructors directly. The
  loader path is an _additional_ way to get a constructor, not a
  replacement — tests keep working.

## Decision

### Module instantiation — **`new AsyncFunction('actjs', js)`**

Compile TS → JS via `typescript.transpileModule`, then evaluate
the JS as the body of an `async function (actjs) { ... }`. The
function returns the class constructor.

User source convention (the contract):

```ts
class Cart extends actjs.Actor {
  @actjs.handler('addItem')
  addItem(args) {
    // Runtime calls go through the per-instance bridge:
    await this.actjs.call(otherRef, 'fetch', {});
  }
}
return Cart;
```

Reasons:

- Zero module-system complexity. No file URLs, no `vm.Module`
  promise dance, no top-level await.
- The "function body that returns the class" convention matches
  the legacy `/run` and `/upload` shape, so the rename `gact` →
  `actjs` is the only user-visible change at the source level.
- Imports and exports are forbidden at publish (see below);
  there's no use case for native module semantics in v1.

### Two `actjs` objects, one name

User source sees `actjs` in two contexts. They're distinct objects
that intentionally share the name:

| Where                        | What it has                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| Compile-time arg `actjs`     | Frozen class kit: `Actor`, `EventSourced`, `Replica`, `handler`.                                   |
| Instance member `this.actjs` | Per-actor runtime bridge: `self`, `call`, `tell`, `scheduleAt`, `now`, `log`, `manifest`, `abort`. |

Reason: documentation calls this out explicitly so the rename
collision doesn't surprise readers. Phase 6.1 codegen will emit
TypeScript types that make the distinction visible without runtime
discriminators.

### LRU cap — **256 modules per process**

Configurable on the loader. The cache is keyed by `sha256(source)`
so two versions with byte-identical source share one entry.
Refcount-aware: a module that has at least one live actor host is
never evicted, even when it would otherwise be LRU-evicted —
guards against compiling-the-same-source-twice churn during
rebalancing.

### Forbidden imports — **regex pass at publish**

`import` / `export` statements are rejected at publish time by a
simple regex in the validator. Reasons:

- The function-body source format doesn't support module syntax;
  shipping it would yield runtime errors anyway.
- Regex is conservative (rejects some valid identifier names like
  `imports` if at start of line) but the rejection message is
  clear. Phase 7.2 (or 8) upgrades to AST-based forbidden-import
  enforcement once we want narrower bans like `fs` / `child_process`.

### Sticky-by-default activation

Class registration defaults to `floating: false`. An actor's
persisted snapshot carries `class_version`; on activation:

| persisted vs registered | Sticky default            | Floating                     |
| ----------------------- | ------------------------- | ---------------------------- |
| equal                   | run the registered ctor   | run the registered ctor      |
| persisted < registered  | load persisted via loader | run registered, migrate snap |
| persisted > registered  | `ManifestRegression`      | `ManifestRegression`         |

Sticky actors keep running the version they were created with
even after a newer version is published. Floating actors move to
the latest registered on every activation (Phase 3.3's `migrate`
hook handles state shape).

### `ManifestRegression` — **hard error**

If the persisted version is _higher_ than what the runtime knows
how to run (because of a deploy rollback or a misconfigured
registry), refuse with a structured `ManifestRegression` error.
Reasons:

- The state may carry shape only the future code knew how to
  serialize; running an older class against it is data corruption
  waiting to happen.
- The fix is one of: re-deploy the newer code; explicitly migrate
  with `actctl actor migrate <id> <oldVersion>`. Both are operator
  decisions, not silent recovery.

## Consequences

### Positive

- The loader makes "two coexisting versions in one process" work
  by default. Sticky actors don't break on a deploy.
- Compile-by-sha cache means a class with N actors compiles once.
- The `actjs` parameter / `this.actjs` split keeps the user-facing
  surface unified at the name level while keeping the static kit
  separate from per-instance state.

### Negative / trade-offs

- `new AsyncFunction` doesn't support real `import` — published
  classes can't pull in npm packages. For v1's self-hosted target
  this is by design (the trusted-code model), but it's a real
  ergonomic limit. A future Phase 9 / 10 may add an "allowlisted
  module" import path.
- Regex import-forbidder will false-positive on identifiers that
  start with `import`/`export` at the beginning of a line. Worth
  the simplicity until we add the AST pass.
- The "two `actjs` objects" thing needs prominent documentation.
  Phase 6.1's codegen will help by emitting `.d.ts` that surfaces
  the right shape per call site.

### Follow-ups for later phases

- Phase 4.3 client-pinned manifests: the manifest sha sent by the
  SDK feeds into the activation logic (the resolved version per
  class drives which loader entry runs).
- Phase 7.2 upgrades the forbidden-import regex to an AST pass
  and adds class-level signing verification before the loader
  caches.
- Phase 6.1 codegen emits a `.d.ts` whose `Actor<S>` is augmented
  with a typed `this.actjs` matching `ActjsHost`.

## Alternatives considered (and why not)

- **`vm.Module`.** Real ES modules, async, supports imports.
  Much more code for a marginal correctness win when our trust
  boundary already disallows imports. Defer.
- **Dynamic `import()` of a `data:` URL.** Works but every load
  hits the module cache & uses VM bookkeeping. Adds latency
  compared to the AsyncFunction route; we'd need our own cache on
  top anyway.
- **AST-based import forbidder in 4.2.** TypeScript exposes
  `forEachChild` walks but the depth of the spec (re-exports,
  side-effect imports, `import type`, dynamic `import()`) makes
  the regex-then-AST progression a sane staging order.
- **Floating-by-default.** Every deploy silently mutates every
  actor's running version. Hard to reason about. Sticky-by-default
  matches every long-lived actor framework (Akka Persistence,
  Orleans).
- **Silent rollback on `ManifestRegression`.** Run the older code
  against newer state. Data corruption mode. Hard error is the
  conservative pick.

## References

- PLAN.md § Phase 4c/4d
- tasks/phase-4-2-loader-version-policy.md
- Phase 1 base classes; Phase 4.1 publisher (`src/registry/publisher.ts`)
