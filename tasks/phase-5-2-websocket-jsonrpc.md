# Phase 5.2 — WebSocket / JSON-RPC

> Source: [PLAN.md § Phase 5b](../PLAN.md#phase-5--api-surface-fastify)
> Decisions: [phase-5-2-websocket-jsonrpc.adr.md](./phase-5-2-websocket-jsonrpc.adr.md)

## Goal

A single `/v1/ws` endpoint speaking JSON-RPC 2.0 carries calls and
subscriptions. Subscriptions deliver SWM patches and ES events
according to the actor model. Manifest pin (4.3) is honored over
the connection lifetime.

## Done when

- A test client opens `/v1/ws`, calls `actor.subscribe` against a
  Counter actor, receives initial snapshot and one patch per
  `tell`.
- A test client subscribes to a Ledger ES actor, receives the
  initial snapshot at seq N and one `event` notification per appended
  event with monotonic seq.
- Idle WS connections receive heartbeat pings; dropped connections
  terminate subscriptions cleanly.
- `actor.unsubscribe` stops further deliveries within ~50 ms.

---

## Checklist

### Transport

- [x] Fastify WebSocket plugin (`@fastify/websocket`).
- [x] One `/v1/ws` endpoint; one Connection per browser tab; many
      logical subscriptions multiplexed.
- [x] Heartbeat: server-sent ping every 30 s; if no pong in 90 s,
      drop.
- [ ] Backpressure: per-connection outbound queue cap; over the
      cap, close with `1009` (message too big) or `1011`.
      _Deferred — drop-oldest with a metric is the chosen v1
      strategy per the ADR; emit gauge in Phase 8.1._

### JSON-RPC layer

- [x] Strict JSON-RPC 2.0 framing.
- [x] Method registry:
  - [x] `actor.call(class, id, method, args, meta?)` →
        `{ result, manifest, seq? }`. _Reply shape:
        `{result}` for v1 — `manifest` / `seq` are bundled
        into the Phase 5.4 pin-over-WS follow-up._
  - [x] `actor.subscribe(class, id, opts?)` → `{ subscriptionId,
snapshot, seq? }`. _Reply shape: `{subscriptionId}` — the
        snapshot is delivered as the first `actor.event`
        notification so the same delivery path covers all kinds._
  - [x] `actor.unsubscribe(subscriptionId)` → `{ ok: true }`.
- [x] Notifications:
  - [x] `actor.event` with shape `{ subscriptionId, kind: 'patch' |
'event' | 'snapshot' | 'tombstone', data, seq? }`.
- [x] Errors use `code` aligned with REST framework codes (negative
      codes per JSON-RPC convention; map by table).

### Subscription engine

- [x] Per-actor subscriber registry in the runtime. _Lives in
      `src/server/subscription-registry.ts`; the registry is
      transport-agnostic so the Phase 5.3 SSE endpoint can reuse it._
- [x] On `subscribe`:
  - [x] Materialize actor (hot/warm/cold).
  - [x] Send initial `snapshot` notification.
  - [x] Register the subscriber on the actor host.
- [x] On every committed mailbox turn:
  - [x] SWM: diff prev state ↔ new state via fast-json-patch;
        broadcast `kind: 'patch'`.
  - [x] ES: broadcast each appended event as `kind: 'event'`.
- [x] On tombstone: broadcast `kind: 'tombstone'` and drop subs.

### Manifest pin over WS

- [ ] The first WS frame (or the `Sec-WebSocket-Protocol` header)
      carries the manifest sha; same handling as 4.3.
- [ ] Every subsequent `actor.call` and `actor.subscribe` reuses
      that manifest.
- [ ] If the pin's grace expires mid-connection, the server emits
      a `notification` warning, then closes with code `4410`
      (custom; documented).
      _All three deferred — see ADR "Manifest pin over WS"; closes
      in Phase 5.4 alongside the REST per-call activation gap._

### Backpressure & fairness

- [ ] Per-connection outbound queue length gauge. _Deferred to
      Phase 8.1 (metrics)._
- [x] Per-actor subscriber cap (default 1000) to bound fanout work.
- [ ] Slow consumers don't slow down the actor: per-subscriber
      buffer up to N events, then drop oldest with a metric tick.
      _Deferred — chosen policy is drop-oldest with a metric
      (ADR); the metric lands in Phase 8.1._

### Tests

- [x] Counter SWM subscription: initial + patch sequence is
      monotonically correct.
- [x] Ledger ES subscription: events delivered in order, no gaps.
- [ ] Reconnect within idle window: subscription state can be
      re-established without state loss (client sends last-seen
      seq for ES, server replays since).
      _Deferred — replay-on-reconnect is queued for Phase 6.2 SDK + a runtime ES-range-scan follow-up (see ADR)._
- [ ] Slow consumer: server doesn't OOM; metric increments.
      _Deferred — drop-oldest policy lands here, metric in 8.1._
- [ ] Concurrent subscribe+unsubscribe storm: no leaked subs after
      a soak test. _Deferred — soak-test infrastructure lands in
      Phase 8.3 (load tests)._

---

## Risks & watch-outs

- [ ] JSON Patch over a deeply nested SWM state can be larger than
      a full snapshot. Add a heuristic: if patch bytes > snapshot
      bytes, send the snapshot instead. Document in the ADR.
      _Documented as v1 "patch always"; metric in 8.1 will
      observe; heuristic deferred._
- [ ] ES catch-up replay on reconnect can fan out millions of
      events. Cap the replay window; if exceeded, force a fresh
      snapshot subscription. _Deferred with reconnect work._
- [x] WS through proxies sometimes terminates silently; heartbeats
      catch most of it but not all. Document timeouts in the ADR.
- [x] Subscription fanout from one hot actor to thousands of
      browsers can saturate a node. The per-actor subscriber cap
      is the v1 mitigation; Phase 9 cluster work is the long-term
      answer.
- [ ] Manifest pin failures mid-connection need a clear client
      story (the SDK in 6.2 must surface the close-code
      meaningfully). _Deferred with the pin-over-WS work._
