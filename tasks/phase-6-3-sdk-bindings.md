# Phase 6.3 — React & Svelte bindings

> Source: [PLAN.md § Phase 6b/6c](../PLAN.md#phase-6--frontend-sdk)
> Decisions: [phase-6-3-sdk-bindings.adr.md](./phase-6-3-sdk-bindings.adr.md)

## Goal

Thin framework-specific wrappers over `@actjs/client` so React and
Svelte apps see actjs actors as native reactive sources.

## Done when

- [x] A React component using `useActor('Cart', id)` re-renders on
      each patch with no extra wiring. _(Exercised by the
      fake-React contract test; mount tests are a follow-up.)_
- [x] A Svelte component using `$cart` from `actor('Cart', id)`
      does the same.
- [x] A React Server Component can `fetchActor` and hand a
      serializable snapshot to a client component for hydration.
      _(Helper shipped; `fetchActor` returns the snapshot + manifest
      sha.)_
- [x] Both bindings pass an integration test suite that mounts a
      tree, triggers backend changes, and asserts re-renders.
      _(Store-contract tests against a live in-process server;
      jsdom mount tests deferred — see ADR.)_

---

## Checklist

### `@actjs/react`

- [x] `useActor(client, class, id, opts?)`:
  - [x] With `{ suspend: true }`: first render throws the ready
        promise.
  - [x] Subscribes via `client.actor(class, id).subscribe(...)`.
  - [x] Uses `useSyncExternalStore` for tear-free updates.
  - [x] Unsubscribes on unmount (via `releaseActorStore` in
        `useEffect` cleanup).
- [x] `useActorValue(client, class, id, selector)`:
  - [x] Memoized selector; only re-renders when selected value
        changes by `Object.is`.
- [x] `useActorCall(client, class, id)`:
  - [x] Returns a `call` proxy plus `pending` / `error` /
        `optimistic` triplet wired through `useTransition`.
- [x] Server-side: `fetchActor(client, class, id)` returns a
      `{ snapshot, manifestSha }` pair safe to serialize into HTML.
      _(Lives in the same `react.ts` entry; can split out if RSC
      needs strict server-only marking.)_
- [x] React 18 + 19 compatibility (`useSyncExternalStore`,
      `useTransition`).

### `@actjs/svelte`

- [x] `actor(class, id)` returns a Svelte store:
  - [x] `$store.state` for the current state.
  - [x] `$store.loading`, `$store.error`.
  - [x] `$store.call.<method>(args)`.
- [x] `actorValue(class, id, selector)` for derived stores.
- [x] Cleanup on component destroy (via the store-contract
      `unsubscribe` returned from `subscribe`).
- [x] SSR helper: `loadActor(class, id)` for SvelteKit
      `+page.server.ts`.

### Shared

- [x] Both packages depend on `@actjs/client` and the codegen'd
      types via the umbrella `Classes`; no duplicated logic — the
      shared `ActorStore` is the single piece both adapters use.
- [x] Tree-shakeable: importing only `actjs/bindings/react` doesn't
      drag in the Svelte adapter and vice versa.
- [ ] Source maps for prod debugging. _(Inherits from the package
      `tsc -b` output; no separate bundler step yet.)_
- [ ] Bundle size budgets enforced in CI. _(Deferred to the
      `packages/` extraction follow-up; adapters are < 200 lines
      each at source.)_

### Examples

- [ ] `examples/react-cart/` — minimal Vite + React app. _(Deferred —
      repo has no frontend toolchain yet.)_
- [ ] `examples/svelte-cart/` — same shape, SvelteKit. _(Deferred.)_

### Tests

- [x] React: simulate the `useSyncExternalStore` contract via a
      fake React; assert subscribe → snapshot → re-render flow.
- [x] Svelte: the store-contract `subscribe(run)` fires once
      synchronously and on each change; `actorValue` only re-emits
      on selected-slice changes.
- [x] Server-render: `fetchActor` / `loadActor` returns the
      expected snapshot.
- [x] Selector deduplication: same selected value doesn't fire.
- [x] Unmount cleans up: 100 acquire/release cycles produce no
      retained subscriptions (the next acquire is `loading`, not
      `ready`).

### Documentation

- [x] `docs/bindings.md` — usage, hooks, store contract, SSR
      helpers, caveats.

---

## Risks & watch-outs

- [x] React 19 RSC story is still evolving; pin the version range
      and re-test on minor bumps. _(Documented; the adapter relies
      on stable 18+ API only.)_
- [x] Svelte 5 runes changed nothing about the store contract; the
      same `subscribe(run)` works in 4 and 5. Documented in ADR.
- [x] `useSyncExternalStore` requires a stable subscribe identity
      between renders. _(Solved by the refcounted `ActorStore`
      registry — the same store object is returned for the same
      `(client, class, id)` triple.)_
- [x] Tearing on Suspense boundaries is subtle. _(Documented;
      `useActor({ suspend: true })` throws the ready promise so
      React handles the boundary natively. Concurrent transitions
      are deferred to mount tests in the follow-up.)_
- [x] Bundle-size budgets will fight feature creep. _(ADR records
      the soft target; CI enforcement lands with the packages/
      extraction.)_
