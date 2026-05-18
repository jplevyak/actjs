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

- [ ] Fastify WebSocket plugin (`@fastify/websocket`).
- [ ] One `/v1/ws` endpoint; one Connection per browser tab; many
      logical subscriptions multiplexed.
- [ ] Heartbeat: server-sent ping every 30 s; if no pong in 90 s,
      drop.
- [ ] Backpressure: per-connection outbound queue cap; over the
      cap, close with `1009` (message too big) or `1011`.

### JSON-RPC layer

- [ ] Strict JSON-RPC 2.0 framing.
- [ ] Method registry:
  - [ ] `actor.call(class, id, method, args, meta?)` →
        `{ result, manifest, seq? }`.
  - [ ] `actor.subscribe(class, id, opts?)` → `{ subscriptionId,
        snapshot, seq? }`.
  - [ ] `actor.unsubscribe(subscriptionId)` → `{ ok: true }`.
- [ ] Notifications:
  - [ ] `actor.event` with shape `{ subscriptionId, kind: 'patch' |
        'event' | 'snapshot' | 'tombstone', data, seq? }`.
- [ ] Errors use `code` aligned with REST framework codes (negative
      codes per JSON-RPC convention; map by table).

### Subscription engine

- [ ] Per-actor subscriber registry in the runtime.
- [ ] On `subscribe`:
  - [ ] Materialize actor (hot/warm/cold).
  - [ ] Send initial `snapshot` notification.
  - [ ] Register the subscriber on the actor host.
- [ ] On every committed mailbox turn:
  - [ ] SWM: diff prev state ↔ new state via fast-json-patch;
        broadcast `kind: 'patch'`.
  - [ ] ES: broadcast each appended event as `kind: 'event'`.
- [ ] On tombstone: broadcast `kind: 'tombstone'` and drop subs.

### Manifest pin over WS

- [ ] The first WS frame (or the `Sec-WebSocket-Protocol` header)
      carries the manifest sha; same handling as 4.3.
- [ ] Every subsequent `actor.call` and `actor.subscribe` reuses
      that manifest.
- [ ] If the pin's grace expires mid-connection, the server emits
      a `notification` warning, then closes with code `4410`
      (custom; documented).

### Backpressure & fairness

- [ ] Per-connection outbound queue length gauge.
- [ ] Per-actor subscriber cap (default 1000) to bound fanout work.
- [ ] Slow consumers don't slow down the actor: per-subscriber
      buffer up to N events, then drop oldest with a metric tick.

### Tests

- [ ] Counter SWM subscription: initial + patch sequence is
      monotonically correct.
- [ ] Ledger ES subscription: events delivered in order, no gaps.
- [ ] Reconnect within idle window: subscription state can be
      re-established without state loss (client sends last-seen
      seq for ES, server replays since).
- [ ] Slow consumer: server doesn't OOM; metric increments.
- [ ] Concurrent subscribe+unsubscribe storm: no leaked subs after
      a soak test.

---

## Risks & watch-outs

- [ ] JSON Patch over a deeply nested SWM state can be larger than
      a full snapshot. Add a heuristic: if patch bytes > snapshot
      bytes, send the snapshot instead. Document in the ADR.
- [ ] ES catch-up replay on reconnect can fan out millions of
      events. Cap the replay window; if exceeded, force a fresh
      snapshot subscription.
- [ ] WS through proxies sometimes terminates silently; heartbeats
      catch most of it but not all. Document timeouts in the ADR.
- [ ] Subscription fanout from one hot actor to thousands of
      browsers can saturate a node. The per-actor subscriber cap
      is the v1 mitigation; Phase 9 cluster work is the long-term
      answer.
- [ ] Manifest pin failures mid-connection need a clear client
      story (the SDK in 6.2 must surface the close-code
      meaningfully).
