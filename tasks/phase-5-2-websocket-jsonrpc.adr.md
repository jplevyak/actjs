# ADR — Phase 5.2: WebSocket / JSON-RPC

> Task: [phase-5-2-websocket-jsonrpc.md](./phase-5-2-websocket-jsonrpc.md)
> Plan reference: [PLAN.md § Phase 5b](../PLAN.md#phase-5--api-surface-fastify)

- **Status:** Accepted
- **Date:** 2026-05-19
- **Decider(s):** project author

## Context

Phase 5.1 put a proper REST surface on the engine. Phase 5.2 adds
the real-time half: a single `/v1/ws` endpoint speaking JSON-RPC
2.0 that multiplexes calls and subscriptions, delivers JSON
Patches for SWM actors and raw events for ES actors, and survives
the routine WS lifecycle hazards (idle drops, slow consumers,
client crashes).

Constraints carried in:

- The Fastify app from 5.1 owns the HTTP listener; the WS plugin
  mounts on the same instance.
- ActorHost's commit path (Phase 3.1 SWM + Phase 3.2 ES) needs a
  notification hook the subscription engine can attach to.
- Per the PLAN.md locked decisions, SWM is JSON Patch (RFC 6902),
  ES is raw events.

## Decision

### Transport — **`@fastify/websocket`**

Mounts on the existing Fastify instance; one connection per
client; one `/v1/ws` route. The underlying `ws` library is
battle-tested.

### Patch library — **`fast-json-patch`**

The Phase 5.2 task and PLAN.md both call it out by name. `compare`
generates RFC 6902 ops between two state snapshots; reasonably
fast at typical actor-state sizes.

### Patch-vs-snapshot heuristic — **patch always in v1**

The PLAN warned that a patch can exceed the snapshot for some
mutations; the ADR recommendation was "send snapshot if
patch.bytes > snapshot.bytes". Implementing this is cheap but
adds a heuristic that's hard to test deterministically. Defer:
v1 always sends patches; v2 layers the heuristic on top with a
metric showing how often it would fire.

### Heartbeat — **server ping every 30 s, drop on no-pong-90 s**

Per the task. Browsers and the `ws` client respond to ping
automatically. The 3× ping-interval timeout absorbs occasional
network blips without paging the user.

### Per-actor subscriber cap — **1000**

Hard cap; over the cap, `actor.subscribe` rejects with a
JSON-RPC error code mapped to `SubscriberLimit`. 1000 is generous
for any real workload — a single hot actor with 1000 subscribers
is already the contention story Phase 9 cluster work has to
solve.

### Per-subscriber buffer policy — **drop-oldest with counter**

Each connection gets a bounded outbound queue (256 messages); on
overflow the oldest is dropped and a `subscriber_drop_total`
counter ticks. Slow consumers don't slow down the source actor.
The connection isn't closed — Phase 8.1 metrics surface drops so
operators can tune.

### Reconnect/replay window — **deferred**

The PLAN.md task lists a "client sends last-seen seq, server
replays" recovery flow. It requires ES event indexing by seq with
range scans plus client-side resume bookkeeping, both of which
are real work. For 5.2 we ship without it; a reconnecting client
gets a fresh `snapshot` event and resumes from there. Recorded as
a Phase 6.2 SDK item.

### Manifest pin over WS — **deferred**

Phase 4.3 carved this out for "Phase 5.x"; 5.1 deferred it; this
ADR continues the punt for 5.2. Mounting the pin handshake into
the WS upgrade is straightforward but requires the same
manifest-threading-through-`runtime.call` plumbing as 5.1 — the
deferred "Phase 5.4" follow-up. Pin observability already counts
HTTP requests; WS connections will join later.

### JSON-RPC framing — **standard 2.0 with named methods**

Methods:

- `actor.call(class, id, method, args)` → `{result, manifest?, seq?}`.
- `actor.subscribe(class, id)` → `{subscriptionId}`.
- `actor.unsubscribe(subscriptionId)` → `{ok: true}`.

Notifications:

- `actor.event` — params `{subscriptionId, kind: 'snapshot' |
'patch' | 'event' | 'tombstone', data, seq?}`.

Errors use JSON-RPC convention (`code: number, message, data`).
Codes mirror the REST framework codes via a table:
`-32601` = method not found; `-32602` = invalid params; framework
errors are `-32000 + offset` with the `code` string in `data.code`.

### bigint serialization — **string in JSON-RPC params**

`seq` is `bigint` in the runtime but JSON can't carry bigints.
Serialized as decimal string in WS payloads. The SDK reverses;
clients that don't care about precision can `Number()` it.

## Consequences

### Positive

- Real-time subscriptions are a single Fastify plugin away. The
  SDK gets a familiar JSON-RPC surface.
- SWM patches are small for most mutation patterns. ES events are
  delivered byte-identically to what the runtime appended.
- The subscription registry is decoupled from the WS transport;
  Phase 5.3's SSE endpoint can reuse it without changes.

### Negative / trade-offs

- No replay-on-reconnect in v1. A flaky network → momentary state
  divergence on the client. SDK in Phase 6.2 implements
  optimistic+resync semantics; until then operators are aware.
- No manifest pin over WS. The pin's deprecation lifecycle is
  enforced only on REST calls. Phase 5.4 closes this.
- 1000 subscribers per actor is a single-process limit; once we
  cluster (Phase 9), each node holds its own. Aggregate cap
  becomes `nodes × 1000` if we want it.
- Patch-always policy means a small write to a large state mostly
  sends a small payload; a large write to a small state can blow
  the patch budget. Acceptable for v1; Phase 8.1 metric will
  surface the worst offenders.

### Follow-ups for later phases

- Phase 5.3 wires the BYO `auth(req)` hook into the WS upgrade.
- Phase 5.4 closes the manifest-pin + per-call activation gap on
  REST and WS together.
- Phase 6.2 SDK adds optimistic + resync semantics, including a
  light replay protocol that the runtime extends to support.
- Phase 8.1 emits `ws_subscribers_active`, `ws_subscriber_drop_total`,
  `ws_patch_bytes` metrics.

## Alternatives considered (and why not)

- **GraphQL Subscriptions / SSE only.** GraphQL adds an opinion
  we're not yet committed to; SSE is the Phase 5.3 fallback for
  proxies that don't pass WS. Run both.
- **Snapshot every change (no patches).** Simpler, but bandwidth
  scales with state size. JSON Patch is the right default for SWM.
- **Per-event replay on reconnect, in v1.** Doable but requires
  client-side state machines we don't have today. Wait for the
  SDK.
- **Strict per-connection backpressure that closes on overflow.**
  Closing punishes legitimate slow consumers (mobile, background
  tabs). Drop-oldest + metric is more forgiving.

## References

- PLAN.md § Phase 5b
- tasks/phase-5-2-websocket-jsonrpc.md
- `@fastify/websocket`: <https://github.com/fastify/fastify-websocket>
- `fast-json-patch`: <https://github.com/Starcounter-Jack/JSON-Patch>
