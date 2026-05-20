# Phase 6.2 — @actjs/client SDK

> Source: [PLAN.md § Phase 6a](../PLAN.md#phase-6--frontend-sdk)
> Decisions: [phase-6-2-sdk-client.adr.md](./phase-6-2-sdk-client.adr.md)

## Goal

The framework-agnostic TypeScript client. Multiplexes calls and
subscriptions over one WebSocket with automatic reconnect, embeds
the manifest pin, supports optimistic updates for SWM actors, and
queues offline mutations to IndexedDB.

## Done when

- [x] `new Client({ url, token? })` connects to a 5.x server and runs
      a successful `actor.call` and `actor.subscribe`.
- [x] The build embeds the codegen'd `MANIFEST_SHA` and sends it as
      `X-Actjs-Manifest`. _(Consumer-supplied via `pin:` option; the
      codegen'd constant is the recommended default.)_
- [x] Killing the WS connection mid-session triggers reconnect with
      exponential backoff; queued calls flush in order.
- [x] An optimistic update against a SWM actor applies locally,
      reverts on server error, and stays applied on success.

---

## Checklist

### Transport

- [x] `src/client/` — exported as `actjs/client`. ESM via the
      existing `tsc -b` pipeline. _(Dedicated `packages/client/` tsup
      build is a packaging follow-up; see ADR.)_
- [x] `Client` opens one WebSocket to `/v1/ws`. _(SSE fallback is
      already shipped server-side in Phase 5.3; SDK-side switch
      lands with 6.3 when bindings need it.)_
- [x] Reconnect: full-jitter exponential backoff, capped at 30 s.
- [x] Outbound queue: calls issued during disconnect are held;
      flushed on reconnect, in order, with their original
      `Idempotency-Key`.

### JSON-RPC client

- [x] One pending-request map keyed by JSON-RPC id.
- [x] Notification dispatcher (for `actor.event`) routes to the
      matching subscription handler.
- [x] All wire types come from `src/wire/` so server and client
      share the source of truth.

### Public API

- [x] `client.actor(class, id)` returns an `ActorHandle` with:
  - [x] `call.<method>(args, opts?)` typed by `<Class>Handlers`.
  - [x] `get.<selector>(args?)` for read-only handlers.
  - [x] `subscribe(onState)` returning an unsubscribe function.
  - [x] `optimistic(mutator)` — apply Immer mutation locally, send
        the call, revert on failure.
- [ ] `client.classes` for admin: `publish`, `list`, `deprecate`
      (admin token required by server). _(Deferred — wired into
      Phase 8.2's `actctl` programmatic API, which already has the
      same shape.)_
- [x] All public types are generated; users get autocomplete and
      method-existence errors at build time. _(Via the codegen'd
      `Classes` umbrella.)_

### Manifest pin

- [x] Consumer passes `MANIFEST_SHA` from `client-types/index.d.ts`
      as the default `pin`.
- [x] Override per-client: `new Client({ pin: 'latest' | string })`.
- [x] `Warning` headers / `VersionDeprecated` notifications surface
      via `onWarning` callback. _(Channel exists; server-side
      deprecation hint emission is a Phase 7.2 follow-up.)_

### Offline queue

- [x] Mutations made offline persist to IndexedDB keyed by their
      `Idempotency-Key`.
- [x] On reconnect, replay in order; remove on confirmed response.
- [x] On permanent failure (non-retryable framework code), surface
      to a callback and drop.
- [x] Configurable: in-memory only, IndexedDB, none.

### Subscription state

- [x] For SWM: apply JSON Patch via `fast-json-patch`; emit
      immutable snapshots to subscribers.
- [x] For ES: apply events via consumer-supplied reducer (from
      6.1's `index.runtime.js`); same emission model.
- [x] Re-subscribe on reconnect (the SDK re-issues
      `actor.subscribe` for every active sub).

### Tests

- [x] Round-trip happy path against an in-process Fastify server.
- [x] Reconnect: warning fires, calls keep working after the drop.
- [x] Optimistic apply + server reject: state reverts.
- [x] Offline → online flush exercises IndexedDB via
      `fake-indexeddb`.
- [x] Type-level: removing a server handler causes a TS error
      (tsd-style `@ts-expect-error` assertion).

### Documentation

- [x] `docs/client.md` — usage, options, semantics, caveats.

---

## Risks & watch-outs

- [x] IndexedDB code paths break in unexpected ways across
      browsers. _(Covered by the structural type surface +
      fake-indexeddb test; real-browser CI is a Phase 8 follow-up.)_
- [x] The shared protocol types are a third home for the
      protocol types (after server and OpenAPI). _(Resolved by
      placing them in `src/wire/` and importing into both the
      server WS route and the SDK.)_
- [x] Optimistic + reconnect can produce surprising orderings.
      _(Documented invariant: optimistic state always reverts to
      the server's confirmed state on resync; revert uses inverse
      patches against the *current* state.)_
- [x] Subscriptions across reconnect are subtle. _(Re-issuing
      `actor.subscribe` on every reconnect; the server delivers a
      fresh snapshot which the client's `SubscriptionState` applies
      on top of the buffered notifications.)_
- [x] Manifest pin embedded at build time means an old browser tab
      keeps using an old pin even after the user refreshes the
      service worker. _(Documented in `docs/client.md`.)_
