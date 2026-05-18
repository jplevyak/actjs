# Phase 6.3 — React & Svelte bindings

> Source: [PLAN.md § Phase 6b/6c](../PLAN.md#phase-6--frontend-sdk)
> Decisions: [phase-6-3-sdk-bindings.adr.md](./phase-6-3-sdk-bindings.adr.md)

## Goal

Thin framework-specific wrappers over `@actjs/client` so React and
Svelte apps see actjs actors as native reactive sources.

## Done when

- A React component using `useActor('Cart', id)` re-renders on each
  patch with no extra wiring.
- A Svelte component using `$cart` from `actor('Cart', id)` does the
  same.
- A React Server Component can `fetchActor` and hand a serializable
  snapshot to a client component for hydration.
- Both bindings pass an integration test suite that mounts a tree,
  triggers backend changes, and asserts re-renders.

---

## Checklist

### `@actjs/react`

- [ ] `useActor(class, id, opts?)`:
  - [ ] First render suspends until the initial snapshot arrives.
  - [ ] Subscribes via `client.actor(class, id).subscribe(...)`.
  - [ ] Uses `useSyncExternalStore` for tear-free updates.
  - [ ] Unsubscribes on unmount.
- [ ] `useActorValue(class, id, selector)`:
  - [ ] Memoized selector; only re-renders when selected value
        changes.
- [ ] `useActorCall(class, id)`:
  - [ ] Returns a `call` function plus `pending` / `error` /
        `optimistic` triplet wired through `useTransition`.
- [ ] Server-side: `@actjs/react/server` exports `fetchActor` for
      RSC; returns a `{ snapshot, manifest }` pair safe to serialize
      into HTML.
- [ ] React 19 compatibility (`use()` for Suspense data, async
      transitions).

### `@actjs/svelte`

- [ ] `actor(class, id)` returns a Svelte 5 rune-style store:
  - [ ] `$store.state` for the current state.
  - [ ] `$store.loading`, `$store.error`.
  - [ ] `$store.call.<method>(args)`.
- [ ] `actorValue(class, id, selector)` for derived stores.
- [ ] Cleanup on component destroy.
- [ ] SSR helper: `loadActor(class, id, ctx)` for SvelteKit
      `+page.server.ts`.

### Shared

- [ ] Both packages depend on `@actjs/client` and `@actjs/client-types`;
      no duplicated logic.
- [ ] Tree-shakeable: importing only `useActor` doesn't drag in
      RSC/server code.
- [ ] Source maps for prod debugging.
- [ ] Bundle size budgets enforced in CI:
  - [ ] `@actjs/react` < 8 KiB gzipped (excluding client).
  - [ ] `@actjs/svelte` < 5 KiB gzipped.

### Examples

- [ ] `examples/react-cart/` — minimal Vite + React 19 app using
      `useActor` and `useActorCall` against the demo classes.
- [ ] `examples/svelte-cart/` — same shape, SvelteKit.
- [ ] Both examples build and run in CI against a composed actjs
      server.

### Tests

- [ ] React: `@testing-library/react` mounts a component using
      `useActor`; backend trigger updates the DOM.
- [ ] Svelte: same idea with `@testing-library/svelte`.
- [ ] Server-render: RSC `fetchActor` returns the expected snapshot;
      hydration doesn't double-fetch.
- [ ] Optimistic round-trip: optimistic mutation re-renders
      instantly; revert path re-renders again on server reject.
- [ ] Unmount cleans up subscriptions (no leaked listeners after
      a stress test).

---

## Risks & watch-outs

- [ ] React 19 RSC story is still evolving; pin the version range
      and re-test on minor bumps.
- [ ] Svelte 5 runes changed the store contract; the binding needs
      both reactive primitives and the `subscribe` contract for
      backwards compat with Svelte 4 consumers (if claiming
      support — decide in ADR).
- [ ] `useSyncExternalStore` requires a stable subscribe identity
      between renders; closures over `id` will break that — wrap
      in `useEffect` + ref.
- [ ] Tearing on Suspense boundaries is subtle; test concurrent
      transitions specifically.
- [ ] Bundle-size budgets will fight feature creep. Set them now,
      enforce in CI from day one.
