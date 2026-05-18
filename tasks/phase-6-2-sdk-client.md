# Phase 6.2 — @actjs/client SDK

> Source: [PLAN.md § Phase 6a](../PLAN.md#phase-6--frontend-sdk)
> Decisions: [phase-6-2-sdk-client.adr.md](./phase-6-2-sdk-client.adr.md)

## Goal

The framework-agnostic TypeScript client. Multiplexes calls and
subscriptions over one WebSocket with automatic reconnect, embeds
the manifest pin, supports optimistic updates for SWM actors, and
queues offline mutations to IndexedDB.

## Done when

- `new Client({ url, token? })` connects to a 5.x server and runs
  a successful `actor.call` and `actor.subscribe`.
- The build embeds the codegen'd `MANIFEST_SHA` and sends it as
  `X-Actjs-Manifest`.
- Killing the WS connection mid-session triggers reconnect with
  exponential backoff; queued calls flush in order.
- An optimistic update against a SWM actor applies locally,
  reverts on server error, and stays applied on success.

---

## Checklist

### Transport

- [ ] `packages/client/` — TS package, ESM + CJS output via tsup.
- [ ] `Client` opens one WebSocket to `/v1/ws`; falls back to
      `EventSource` if WS unavailable (config flag).
- [ ] Reconnect: full-jitter exponential backoff, capped at 30 s.
- [ ] Outbound queue: calls issued during disconnect are held;
      flushed on reconnect, in order, with their original
      `Idempotency-Key`.

### JSON-RPC client

- [ ] One pending-request map keyed by JSON-RPC id.
- [ ] Notification dispatcher (for `actor.event`) routes to the
      matching subscription handler.
- [ ] All wire types come from a shared `@actjs/wire` package so
      server and client share the source of truth (see 5.1).

### Public API

- [ ] `client.actor(class, id)` returns an `ActorHandle` with:
  - [ ] `call.<method>(args, opts?)` typed by `<Class>Handlers`.
  - [ ] `get.<selector>(args?)` for read-only handlers.
  - [ ] `subscribe(onState)` returning an unsubscribe function.
  - [ ] `optimistic(mutator)` — apply Immer mutation locally, send
        the call, revert on failure.
- [ ] `client.classes` for admin: `publish`, `list`, `deprecate`
      (admin token required by server).
- [ ] All public types are generated; users get autocomplete and
      method-existence errors at build time.

### Manifest pin

- [ ] At build time, `import { MANIFEST_SHA } from '@actjs/client-types'`
      is the default pin.
- [ ] Override per-client: `new Client({ pin: 'latest' | string })`.
- [ ] `Warning` headers / `VersionDeprecated` notifications surface
      as a typed event the application can listen on.

### Offline queue

- [ ] Mutations made offline persist to IndexedDB keyed by their
      `Idempotency-Key`.
- [ ] On reconnect, replay in order; remove on confirmed response.
- [ ] On permanent failure (4xx other than 408/429), surface to a
      callback and drop.
- [ ] Configurable: in-memory only, IndexedDB, none.

### Subscription state

- [ ] For SWM: apply JSON Patch via `fast-json-patch` to a local
      Immer draft; emit immutable snapshots to subscribers.
- [ ] For ES: apply events via the generated client-side reducer
      (from 6.1); same emission model.
- [ ] Replay-on-reconnect (ES): client sends last-seen seq; server
      replays.

### Tests

- [ ] Round-trip happy path against a running server in CI.
- [ ] Reconnect with queued mutations: order preserved, no dupes.
- [ ] Optimistic apply + server reject: state reverts.
- [ ] Offline → online flush exercises IndexedDB (use
      `fake-indexeddb` in CI).
- [ ] Type-level: removing a server handler causes a TS error in
      the client typecheck (uses a tsd-style assertion).

---

## Risks & watch-outs

- [ ] IndexedDB code paths break in unexpected ways across
      browsers. Test in at least Chromium and Firefox CI matrices.
- [ ] The shared `@actjs/wire` package is a third home for the
      protocol types (after server and OpenAPI). Make sure all
      three are generated from one source — don't hand-maintain.
- [ ] Optimistic + reconnect can produce surprising orderings.
      Document the invariant: optimistic state always reverts to
      the server's confirmed state on resync.
- [ ] Subscriptions across reconnect are subtle. If a sub races
      against a tombstone delivered to the old connection, the
      new connection's first event must include the tombstone
      hint.
- [ ] Manifest pin embedded at build time means an old browser tab
      keeps using an old pin even after the user refreshes the
      service worker. Document this in the SDK README so apps know
      to invalidate caches on schema-breaking releases.
