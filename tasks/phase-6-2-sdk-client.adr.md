# ADR — Phase 6.2: @actjs/client SDK

> Task: [phase-6-2-sdk-client.md](./phase-6-2-sdk-client.md)
> Plan reference: [PLAN.md § Phase 6a](../PLAN.md#phase-6--frontend-sdk)

- **Status:** Accepted
- **Date:** 2026-05-20
- **Decider(s):** John Plevyak

## Context

The framework-agnostic client is what the React and Svelte
bindings (6.3) wrap. Its API and reconnect/offline behavior set
the shape of every consumer's data layer.

Shipped scope:

- One `Client` instance per app session, multiplexing every call
  and subscription over one WebSocket.
- Reconnect, pending-request replay, subscription re-establishment.
- Optimistic mutation for SWM actors via Immer.
- Pluggable offline queue (memory / IndexedDB / none).
- Manifest pin sent on every request.
- Shared wire types at `src/wire/` for server + client parity.

## Decision

### Reconnect strategy — **full-jitter exponential**

```
delay = uniform(0, min(30_000ms, 250ms * 2^attempt))
```

Reasons:

- Prevents thundering-herd on server restart (every client picks
  a fresh delay).
- Bounded at 30 s so a long outage still recovers promptly.
- Standard AWS-architecture recommendation; well understood by
  ops engineers, easy to reason about in logs.

Rejected: fixed backoff (herd), pure exponential (predictable
collisions), no-reconnect (caller burden).

### Offline persistence default — **memory; IndexedDB opt-in**

Default `offlineQueue: 'memory'`. Reasons:

- Most apps don't actually want offline-write semantics (think
  one-shot CRUD UIs); IndexedDB-by-default would silently retain
  failed mutations across reloads in ways the developer didn't
  ask for.
- IndexedDB has surprising semantics: Safari private mode, quota
  errors, schema migrations. Opt-in keeps the default path
  predictable.
- The backend is pluggable, so apps that need durable persistence
  can pass `'indexeddb'` or supply a custom backend (e.g. one
  backed by `localforage`, or a server-side queue for native
  shells).

### Optimistic update library — **Immer**

Immer's `produceWithPatches` gives us both the new state and the
inverse patches in a single pass. Reverting on server rejection
applies the inverse patches to the _current_ state, not the
forked one — so concurrent server-driven updates aren't clobbered
on rollback.

Rejected: hand-rolled structural sharing (more code, more bugs);
no optimistic (insufficient — UX expectations require it).

ES actor optimistic updates are explicitly out of scope here.
Predicting events client-side requires duplicating server-side
business logic against the user's mutator; it can land in a 6.2b
follow-up if demand emerges.

### Bundle format — **ESM via existing `tsc -b` output**

The SDK lives at `src/client/` and is exported through the same
`actjs` package as the server. Consumers import it as
`actjs/client`. The tsup setup the original task envisioned would
have produced a separate `packages/client/` ESM+CJS publish target;
we deferred that to keep the monorepo single-package for now.

Reasons:

- One install (`npm i actjs`) gives a consumer both the server
  runtime types and the client SDK. The exports map keeps the two
  surfaces cleanly separated.
- TS targets `es2022` and emits ESM only. Apps that need CJS
  re-bundle via their own tool (Vite, webpack, etc.), which is
  the common shape now.
- The `packages/client/` extraction is a packaging change, not an
  API change; it can happen in any later release without breaking
  consumers.

### Browser support matrix — **evergreen + Safari 14**

Targeted runtimes:

- Chrome / Edge / Firefox / Safari current and current-1.
- Safari 14+ (iOS 14+) — important because mobile Safari upgrades
  slowly and many apps must support a 2-year tail.
- Node 20+ for SSR / tests.

Constraints this places:

- `globalThis.crypto.getRandomValues` is required; we polyfill
  with `Math.random` if absent (older Safari minor versions).
- `globalThis.crypto.randomUUID` is **not** assumed — the SDK
  generates Idempotency-Keys via `getRandomValues` + hex encode.
- IndexedDB is assumed available when the consumer opts in.
- WebSocket is required; we expose `wsCtor` so Node test environments
  can inject the `ws` package.

Older browsers (IE / pre-iOS-14) are out of scope.

### Shared wire types — **`src/wire/` single source of truth**

The protocol envelope (JSON-RPC request/response/notification,
`actor.event` notification shape, framework error codes) lives at
`src/wire/index.ts` and is imported by both the server's WS route
and the client's `RpcClient`. There is no separate
`@actjs/wire` npm package today; if the SDK eventually extracts
to `packages/client/`, `src/wire/` extracts alongside.

Rejected:

- Re-declaring the protocol in each package (drift risk).
- OpenAPI-generated TypeScript (would require a third tool in the
  loop; WS framing isn't OpenAPI).

### Subscription race handling — **buffer notifications by id**

The server delivers the initial `snapshot` synchronously inside
`subscribe()` _before_ it sends the JSON-RPC response. The client's
`await rpc.request(...)` resolves only on the response, so the
snapshot notification can arrive first — at which point we don't
yet know the `subscriptionId`.

Fix: `SubscriptionState` buffers notifications for unknown
subscriptionIds for 5 seconds. The `register`/`flushBuffered`
split lets the Client attach the user's listener before the
buffered snapshot fires.

Rejected: requiring the server to send the response first
(complicates the server's sink lifecycle); skipping the snapshot
and waiting for the next patch (loses the initial state until the
next commit).

## Consequences

### Positive

- One transport, one socket, one auth path — consumers don't have
  to think about REST vs WS for the application surface.
- Reconnect/replay is "just works" behavior for the developer:
  active subscriptions resume, calls retry with the same
  Idempotency-Key.
- Optimistic + Immer makes UI code straightforward: mutate a draft;
  the SDK handles apply, send, and revert.
- The offline queue is pluggable; apps that don't want it pay no
  cost beyond a memory map.

### Negative / trade-offs

- ES optimistic updates aren't supported; ES apps must use plain
  `call` for now.
- The browser-tab caveat (stale pinned manifest after deploy) is
  inherent to client-side pinning. Documented in `docs/client.md`;
  the operational answer is a service-worker invalidation strategy
  per app.
- The shared `wire/` types live in the server package; downstream
  consumers can't `import` from `actjs/wire` without also pulling
  the server. Acceptable for monorepo apps; a polyrepo extraction
  ships when the SDK becomes its own package.
- Reconnect re-issues `actor.subscribe`, producing a fresh
  `subscriptionId`. Server-side subscription bookkeeping by-id is
  not portable across the reconnect; the SDK papers over this for
  callers but the wire log shows two distinct subscriptionIds.

### Follow-ups for later phases

- **6.2b — ES optimistic** if demand emerges (`predictEvents`
  callback that returns the events the SDK can fold locally).
- **6.3 — React / Svelte bindings** consume `ActorHandle`'s API
  as-is; no SDK changes expected.
- **Phase 7a/7b — policy + capabilities** — surface authorization
  rejections via a typed `RpcError.frameworkCode` (already wired
  for `Unauthorized` / `Forbidden`).
- **Phase 8 — observability** — emit a `client_reconnect_total`
  counter via `onWarning` so apps can wire metrics.

## Alternatives considered (and why not)

- **Separate `packages/client/` with tsup-based ESM+CJS build.**
  Premature for a single-repo setup; trivial to extract later.
- **Polling fallback when WS isn't available.** SSE already serves
  that role server-side; adding polling to the SDK would multiply
  retry semantics. Apps that need SSE fallback can wire it via
  the SSE endpoint directly until 6.3 picks it up.
- **Server-driven idempotency-key generation.** The server already
  accepts client-supplied keys; minting on the client keeps the
  retry path entirely SDK-local.

## References

- [docs/client.md](../docs/client.md) — operator/developer guide.
- [src/client/](../src/client/) — implementation.
- [src/wire/index.ts](../src/wire/index.ts) — shared envelope types.
- [src/server/routes/ws.ts](../src/server/routes/ws.ts) — server-side
  WS dispatch, mirror of the SDK's `RpcClient`.
- [tests/client/client.test.ts](../tests/client/client.test.ts) —
  integration test surface.
- [Immer docs](https://immerjs.github.io/immer/) — used for
  optimistic patches.
- [AWS Architecture: exponential backoff and jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/).
