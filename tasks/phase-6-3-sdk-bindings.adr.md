# ADR — Phase 6.3: React & Svelte bindings

> Task: [phase-6-3-sdk-bindings.md](./phase-6-3-sdk-bindings.md)
> Plan reference: [PLAN.md § Phase 6b/6c](../PLAN.md#phase-6--frontend-sdk)

- **Status:** Accepted
- **Date:** 2026-05-20
- **Decider(s):** John Plevyak

## Context

The bindings are how application developers actually use actjs.
They need to feel native to each framework, not like ported APIs.

The shipped adapters live alongside `@actjs/client` in this repo:

```
src/bindings/
├── store.ts      shared, framework-agnostic ActorStore registry
├── react.ts      configureReact, useActor, useActorValue, useActorCall, fetchActor
├── svelte.ts     actor, actorValue, loadActor
└── index.ts      barrel for the shared helpers
```

React and Svelte are **peer dependencies**; the actjs package
declares the hook surface and the store contract but doesn't bundle
either framework. Example apps and bundle-size CI checks are
deferred — see the task file for what landed this session vs what's
still open.

## Decision

### Shared core — **reference-counted ActorStore registry**

`getActorStore(client, class, id)` returns the canonical store for
a triple; multiple hooks observing the same actor share one
upstream subscription. `releaseActorStore` decrements; on zero the
upstream is torn down. The registry lives on the `Client`
instance via a `Symbol.for` key, so multiple clients don't share
state.

This is the property React's `useSyncExternalStore` needs (stable
`subscribe` identity across renders) and the property Svelte's
store contract assumes for deduplication. Putting it in
`src/bindings/store.ts` keeps the React and Svelte files thin —
each adapter is ~150 lines.

### React minimum supported version — **18 + 19**

The hook surface (`useSyncExternalStore`, `useTransition`,
`useState`, `useEffect`, `useMemo`, `useCallback`) is in React 18
and is unchanged in React 19. The optional `use(promise)` import
isn't required — `useActor({ suspend: true })` throws the ready
promise directly, which both 18 and 19 handle.

We expose `configureReact(React)` so the adapter doesn't `import
React from 'react'`. Reasons:

- Apps without React see zero React pull from `actjs`.
- Apps with non-bundler React loading (import-maps, CDNs) don't
  end up with two React copies.
- Storybook / SSR layers that wrap React (e.g. a `react-shim`)
  install the wrapped version.

### Svelte minimum supported version — **4 and 5**

The store contract (`subscribe(run): unsubscribe`) is identical
in Svelte 4 and 5. We target the lowest common shape so the same
binding works in both. Svelte 5 consumers can compose with
`$state`/`$derived` runes by reading `$store` exactly as they would
have in 4.

The adapter doesn't depend on Svelte's `writable` helper — we
implement the readable contract directly so the import is
zero-cost.

### Suspense vs imperative loading — **opt-in Suspense for React, never for Svelte**

`useActor(...)` defaults to "return undefined while loading."
Pass `{ suspend: true }` to throw the ready promise for the
nearest Suspense boundary.

Reasons:

- Imperative loading is what most consumers wire today; making
  Suspense the default would force an architectural change.
- Suspense interacts badly with concurrent transitions when the
  surrounding tree doesn't expect to suspend. Opt-in lets the
  consumer scope it.
- Svelte has no equivalent — the `actor(...)` store always exposes
  `{ state, loading, error }` and the `.svelte` file uses
  `{#if $cart.loading}` to gate rendering.

### Bundle size targets — **deferred, soft budget**

The task envisions strict CI-enforced size budgets (< 8 KiB React,
< 5 KiB Svelte). We're not enforcing those yet because the repo
doesn't have a bundler-based build; the source-level adapters are
small (~150 lines each) and the dominant cost in any consumer's
bundle is `@actjs/client` + Immer.

When the repo extracts dedicated `packages/react` /
`packages/svelte` (Phase 6.3b, post-monorepo move), the budgets
become a CI gate via `size-limit` or `bundlewatch`.

### Server-component support — **fetchActor / loadActor**

Both adapters export an async function that returns
`{ snapshot, manifestSha }` for SSR / RSC hydration:

- `fetchActor(client, class, id)` (React; works in any async
  context).
- `loadActor(client, class, id)` (Svelte; idiomatic for
  `+page.server.ts`).

The return shape is framework-agnostic; the React entry exposes
both names for discoverability. Server-only features (React
`use()`, Suspense for data, Server Actions) are out of scope.

### Subscription lifecycle — **refcounted ActorStore + lazy teardown**

When a React component unmounts (or a Svelte subscriber drops to
zero), `releaseActorStore` runs. The store stays alive until the
last reference releases, at which point the upstream `actor.unsubscribe`
fires. Subscriptions across StrictMode remounts deduplicate via
the registry.

Race notes:

- The initial snapshot can arrive before `register` runs — solved
  upstream in Phase 6.2's `SubscriptionState.preRegister`.
- 100 rapid acquire/release cycles before the snapshot lands
  cause 100 `actor.subscribe` RPCs to reject with "client closed"
  when the test tears down. The `store.ready` promise is
  pre-`.catch(noop)` so these don't surface as unhandled
  rejections.

## Consequences

### Positive

- One source of truth (`ActorStore`) for both adapters; bug fixes
  land once.
- React and Svelte consumers write framework-native code without
  forking the SDK.
- Optional React peer means the actjs package is usable by Svelte
  apps without paying for React's type graph (and vice versa).
- The Suspense path is opt-in, so existing imperative-loading
  apps don't break.

### Negative / trade-offs

- `configureReact(React)` is one extra line of setup. Documented;
  the alternative (direct `import React`) would couple actjs to
  React's package shape.
- The shipped tests are store-contract assertions; full mount
  tests for React and Svelte are a follow-up that requires
  jsdom + testing-library devDeps.
- Example apps (`examples/react-cart/`, `examples/svelte-cart/`)
  are deferred — the repo doesn't yet have a frontend build
  toolchain. When it grows one, those land alongside.
- Bundle-size budgets are documented in the task file but not
  enforced; if a future change grows the adapter, it can slip
  through.

### Follow-ups for later phases

- **Phase 6.3b (post-monorepo extraction):** move adapters into
  `packages/react` / `packages/svelte`, add example apps, wire
  `size-limit` into CI.
- **React 19 `use()` for direct promise unwrapping** — when 19 is
  the only target, simplify the suspend path.
- **Solid / Vue adapters** — copy the Svelte adapter (store
  contract is identical for Solid via `createMemo`).

## Alternatives considered (and why not)

- **Direct `import React from 'react'`.** Couples the actjs
  package to React's specific entry shape; breaks Svelte-only
  apps; problematic for CDN/import-map setups.
- **A single `useActorStore` hook with caller-supplied React
  binding.** Pushes the framework integration cost to the
  consumer; defeats the "feels native" goal.
- **Separate npm packages from day one (`@actjs/react`,
  `@actjs/svelte`).** Premature — the package needs the monorepo
  extraction first. Adapter code lives at `src/bindings/` for
  now and can extract verbatim later.
- **A higher-level "actor model" hook that owns a router-style
  store** — overreach for v1; bindings should be primitives the
  consumer can compose, not application frameworks.

## References

- [docs/bindings.md](../docs/bindings.md) — consumer guide.
- [src/bindings/store.ts](../src/bindings/store.ts) — registry +
  selectStore.
- [src/bindings/react.ts](../src/bindings/react.ts) — React adapter.
- [src/bindings/svelte.ts](../src/bindings/svelte.ts) — Svelte
  adapter.
- [tests/bindings/bindings.test.ts](../tests/bindings/bindings.test.ts)
  — store contract + fake-React + Svelte-shape tests.
- [React docs — useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)
- [Svelte docs — store contract](https://svelte.dev/docs/svelte-store)
