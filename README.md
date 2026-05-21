# actjs

A self-hosted actor framework for JavaScript and TypeScript backends.

Actors are addressable, single-writer objects with durable state. Each
actor's mailbox runs serially; concurrent callers get JSON-RPC over a
WebSocket and see state changes as RFC 6902 patches (single-writer
mailbox actors) or raw events (event-sourced actors). Class source is
a first-class entity with semver, content-addressed bytes, and a frozen
dependency graph — once a client has resolved a manifest, every actor
call rooted in that request runs against the exact same class versions
end-to-end.

- **Concurrency model.** Single-writer mailbox per actor; opt-in event
  sourcing per class.
- **Wire protocol.** URL-versioned REST + JSON-RPC 2.0 over WebSocket;
  SSE fallback.
- **Frontend story.** Typed `@actjs/client` plus `@actjs/react` and
  `@actjs/svelte` bindings; `actctl codegen` emits a `.d.ts` bundle and
  a `manifest.json` per build so calling a non-existent method is a
  compile error.
- **Storage.** Valkey (hot path, mailboxes, locks) + Postgres (system of
  record: classes, snapshots, event log, audit).

See [PLAN.md](./PLAN.md) for the v1 design,
[tasks/ROADMAP.md](./tasks/ROADMAP.md) for what's queued post-8.2,
[DESIGN.md](./DESIGN.md) for the architecture,
[MONOREPO.md](./MONOREPO.md) for the frontend↔backend monorepo
layout, and [CHANGELOG.md](./CHANGELOG.md) for what shipped in which
release.

---

## Concepts

- **Actor.** Addressable by `(class, id)`. Methods marked `@handler`
  are exposed over the wire. The actor's mailbox is the single serial
  writer — handlers never race with each other.
- **Class.** Published TypeScript source, versioned by semver,
  content-addressed by `sha256(source)`. Publishing is immutable;
  deprecation is a separate lifecycle.
- **Manifest.** A frozen `ClassName → Version` map resolved from a
  set of root requirements. Once a client pins a manifest sha, every
  call rooted at that request uses the same versions, including
  through actor-to-actor calls.
- **SWM actors.** Subclass `Actor<S>`. Handlers mutate `this.state`;
  the host snapshots on a trailing debounce. Subscribers see RFC 6902
  patches.
- **ES actors.** Subclass `EventSourced<S, E>`. Handlers return events;
  the host appends atomically, then folds with the user's pure
  `reduce`. Subscribers see the appended events. Replay is the source
  of truth.
- **Reminders.** `actjs.scheduleAt(when, type, payload)` enqueues a
  durable `tell` that fires on a wall-clock deadline; survives restarts.
- **Capabilities.** Short-lived signed tokens scoped to an actor and a
  method set. Useful for shareable read links and SSR.

---

## Quick start

```bash
docker compose up --build           # actjs + Valkey + Postgres
```

Publish a class:

```bash
actctl publish ./src/actors/Cart.ts --version 1.4.2
```

Resolve a manifest and grab its sha:

```bash
actctl manifest show --root Cart@1.4.2
# → { sha256: "...", resolved: { Cart: "1.4.2", Item: "1.0.9" } }
```

Generate the typed client bundle:

```bash
actctl codegen --out ./client-types
```

Use it from a React app:

```tsx
import { Client } from '@actjs/client';
import { useActor, useActorValue } from '@actjs/react';
import type { Cart } from './client-types';

const client = new Client({ url: '/api', token });

function CartView({ id }: { id: string }) {
  const cart = useActor<Cart>('Cart', id);
  const total = useActorValue<Cart, number>('Cart', id, (c) => c.total);
  return (
    <>
      <p>Total: {total}</p>
      <button onClick={() => cart.call.addItem({ sku: 'X', qty: 1 })}>Add</button>
    </>
  );
}
```

---

## Writing actor classes

### SWM (single-writer mailbox)

```ts
import { Actor, handler } from 'actjs';

interface CartState {
  items: Array<{ sku: string; qty: number }>;
}

export class Cart extends Actor<CartState> {
  override onInit(): void {
    this.state = { items: [] };
  }

  @handler('addItem')
  addItem(args: { sku: string; qty: number }): number {
    this.state.items.push(args);
    return this.state.items.length;
  }

  @handler('total')
  total(): number {
    return this.state.items.reduce((s, i) => s + i.qty, 0);
  }
}
```

Inside a handler you have access to a per-instance `this.actjs` bridge:

| Method                                 | What it does                                                     |
| -------------------------------------- | ---------------------------------------------------------------- |
| `this.actjs.self`                      | `{ class, id }` of the current actor                             |
| `this.actjs.call(ref, method, args)`   | Request/response to another actor (runs under the same manifest) |
| `this.actjs.tell(ref, type, payload)`  | Fire-and-forget; entry is durable before the call returns        |
| `this.actjs.scheduleAt(when, type, p)` | Durable reminder; auto-rebound from PG on restart                |
| `this.actjs.now()`                     | Test-seam clock                                                  |
| `this.actjs.log`                       | Structured pino logger; `requestId` / `actorId` already bound    |
| `this.actjs.abort(reason)`             | Aborts the in-flight handler; the caller sees `ActorAbort`       |

### ES (event-sourced)

```ts
import { EventSourced, handler } from 'actjs';

interface LedgerState {
  balance: number;
}
type LedgerEvent = { type: 'Deposited'; amount: number } | { type: 'Withdrawn'; amount: number };

export class Ledger extends EventSourced<LedgerState, LedgerEvent> {
  initialState(): LedgerState {
    return { balance: 0 };
  }
  reduce(s: LedgerState, e: LedgerEvent): LedgerState {
    return e.type === 'Deposited'
      ? { balance: s.balance + e.amount }
      : { balance: s.balance - e.amount };
  }
  @handler('deposit')
  deposit(args: { amount: number }): LedgerEvent[] {
    return [{ type: 'Deposited', amount: args.amount }];
  }
}
```

ES handlers don't write state directly — they return events. The host
appends them atomically, then folds via `reduce`. Cold-start reads the
last snapshot + every event after it and rebuilds state by re-applying
`reduce`.

### Authorization

Each class can declare a `policy()` static. The runtime invokes it on
every call before dispatch:

```ts
static policy(p: Principal, action: PolicyCtx<Cart>): PolicyDecision {
  if (action.kind === 'call' && action.method === 'addItem') {
    return p.sub === action.actor.state.ownerId ? 'allow' : 'deny';
  }
  return 'deny';
}
```

A YAML DSL for the common owner-only / role-match / tag-match cases is
roadmapped — see [tasks/ROADMAP.md](./tasks/ROADMAP.md) Tier 5. JS
`policy()` statics are the supported v1 surface.

### Migrations

When a class is registered at a newer version than a previously
persisted snapshot, the host runs `migrate()` (SWM) or `migrateEvent()`
(ES) before opening the actor to traffic. The prior snapshot is
retained at `seq = -1` for the configured rollback window.

```ts
override migrate(prev: unknown, prevVersion: string): CartV2State {
  const old = prev as CartV1State;
  return { ...old, currency: 'USD' };
}
```

---

## Versioning, manifests, and pinning

```bash
# Publish a new version of Cart.
actctl publish ./src/actors/Cart.ts --version 1.4.2

# Resolve a dep tree.
actctl manifest show --root Cart@1.4.2 --range Item@^1.0.0
# → sha256: ..., resolved: { Cart: "1.4.2", Item: "1.0.9" }

# Deprecate (hides from new resolutions; pinned clients keep working).
actctl deprecate Cart@1.4.0 --reason "use 1.4.2+" --grace 30d

# Inspect who's still pinned to a deprecated version.
actctl manifest in-use
```

Manifests are content-addressed: the same set of resolved versions
always hashes to the same sha. The SDK build embeds the sha returned
by `actctl codegen` and sends it as `X-Actjs-Manifest: <sha>` on every
call. Server behavior:

| Pin status                          | Server response                                       |
| ----------------------------------- | ----------------------------------------------------- |
| Unknown sha                         | `400 ManifestUnknown`                                 |
| Sha references a deprecated version | `200` with `Warning: 299 - "VersionDeprecated <ref>"` |
| Sha references an expired version   | `410 Gone` with the offending refs                    |
| Healthy                             | `200`, no warning                                     |

The resolver rejects with a structured `409 DepConflict` that includes
the path through deps producing every incompatible constraint, so the
caller can see exactly which transitive range disagreed.

Per-actor activation policy:

- **Sticky by default** — an actor keeps running the class version it
  was created with. Older versions are loaded by the in-process
  `ClassLoader` (LRU + refcount).
- **Floating opt-in** — `register({ floating: true })` makes every
  activation use the latest registered version, walking `migrate()`
  if the snapshot predates it.
- Refusing to run older code against newer state is a hard error
  (`ManifestRegression`).

---

## HTTP API

The HTTP layer is Fastify + Zod; routes are validated and typed
end-to-end. OpenAPI 3.1 is exported at `GET /openapi.json`.

### REST

```bash
# Create an actor (mints a fresh id; onInit fires on first call).
curl -X POST http://127.0.0.1:3000/v1/actors/Cart -d '{}' \
  -H "Content-Type: application/json"
# → 201 { class: "Cart", id: "0190..." }

# Invoke a handler. Idempotency-Key turns network retries into a
# one-line contract; replays are byte-identical and carry
# `Idempotency-Replayed: true`.
curl -X POST http://127.0.0.1:3000/v1/actors/Cart/<id>/addItem \
  -H "Content-Type: application/json" \
  -H "X-Actjs-Manifest: <sha>" \
  -H "Idempotency-Key: <uuid>" \
  -d '{"sku": "X", "qty": 1}'

# Read the snapshot.
curl http://127.0.0.1:3000/v1/actors/Cart/<id>

# Tombstone.
curl -X DELETE http://127.0.0.1:3000/v1/actors/Cart/<id>
```

Errors use `application/problem+json` with a stable `code` field:
`DepConflict`, `ManifestUnknown`, `Gone`, `Forbidden`, `MailboxFull`,
`SchemaInvalid`, `SyntaxInvalid`, `ManifestRegression`, etc. The SDK
switches on `code`, not on HTTP status or `title`.

### WebSocket / JSON-RPC

A single endpoint at `/v1/ws` speaks JSON-RPC 2.0 and multiplexes
calls and subscriptions over one connection. Methods:

- `actor.call(class, id, method, args)` → `{result}`.
- `actor.subscribe(class, id)` → `{subscriptionId}`. The first
  `actor.event` notification carries the initial `snapshot`; subsequent
  notifications carry `patch` (SWM) or `event` (ES).
- `actor.unsubscribe(subscriptionId)` → `{ok}`.

```js
const ws = new WebSocket('ws://127.0.0.1:3000/v1/ws');
ws.onmessage = (m) => console.log(JSON.parse(m.data));
ws.send(
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'actor.subscribe',
    params: { class: 'Cart', id: '<actor-id>' },
  }),
);
// ← { id: 1, result: { subscriptionId: '...' } }
// ← { method: 'actor.event', params: { kind: 'snapshot', data: { ... } } }
// ← { method: 'actor.event', params: { kind: 'patch', patch: [...] } }
```

Heartbeats: server pings every 30s; the connection closes with
`1001 heartbeat timeout` if no pong arrives within 90s. Per-actor
subscriber cap (default 1000) protects fanout from a single hot key.

### SSE fallback

Some corporate proxies eat WS traffic. `GET /v1/sse/:class/:id`
returns a server-sent-event stream of the same `actor.event`
notifications; `actor.call` is still a regular POST. The SDK falls
back automatically.

### Auth

The server takes a BYO `auth(req): Promise<Principal>` hook at
boot. The resolved principal is bound on `req.principal` and threaded
into the class `policy()` static.

```ts
import { buildApp } from 'actjs/server';

const app = await buildApp({
  driver,
  runtime,
  auth: async (req) => verifyJwt(req.headers.authorization),
});
```

Token formats — JWT, opaque session, capability — are entirely
operator-chosen. The runtime only sees the resulting `Principal`.

---

## Frontend SDK

### `@actjs/client`

```ts
import { Client } from '@actjs/client';
import type { Cart } from './client-types';

const client = new Client({ url: '/api', token });
const cart = client.actor<Cart>('Cart', cartId);

await cart.call.addItem({ sku: 'X', qty: 2 });
const total = await cart.get.total();

cart.subscribe((state) => render(state)); // WS under the hood
```

- Method signatures come from the `actctl codegen` `.d.ts` bundle.
- One WebSocket per `Client`, multiplexed across every `subscribe` and
  `call`. Exponential backoff + replay on reconnect.
- **Optimistic updates** (SWM): `cart.optimistic(draft =>
draft.items.push(x))` applies locally via Immer, sends the call,
  reverts on failure.
- **Offline queue:** mutations persist to IndexedDB keyed by their
  `Idempotency-Key` and replay on reconnect.
- **ES clients** receive events and fold them with the generated
  reducer client-side; the local state is byte-identical to the
  server's by construction.

### `@actjs/react`

```tsx
const cart = useActor<Cart>('Cart', id); // Suspense for initial load
const total = useActorValue<Cart, number>('Cart', id, (c) => c.total);
```

Built on `useSyncExternalStore` for updates, `Suspense` for cold load,
`useTransition` for optimistic. `@actjs/react/server` exports
`fetchActor(class, id, { manifest })` for RSC hydration.

### `@actjs/svelte`

```svelte
<script lang="ts">
  import { actor } from '@actjs/svelte';
  import type { Cart } from './client-types';
  const cart = actor<Cart>('Cart', id);
</script>

<p>Total: {$cart.total}</p>
```

Svelte 5 runes API; `$cart` is a readable store with `call`,
`loading`, `error` siblings.

---

## `actctl` CLI

The subcommands marked **shipped** are wired today. Everything else is
roadmapped to 8.2b — see [tasks/ROADMAP.md](./tasks/ROADMAP.md) Tier 3.

| Command                                    | Status  | What it does                                               |
| ------------------------------------------ | ------- | ---------------------------------------------------------- |
| `actctl codegen`                           | shipped | Generate the `.d.ts` bundle + `manifest.json` for the SDK  |
| `actctl publish --name --version --source` | shipped | Publish a class version (Ed25519 `--sign` optional)        |
| `actctl key add --kid --pem`               | shipped | Register a publish signing key with the server             |
| `actctl key revoke --kid`                  | shipped | Revoke a signing key                                       |
| `actctl dev`                               | 8.2b    | Watch local class dir; republish pre-release versions      |
| `actctl list`                              | 8.2b    | List class versions and their deprecation state            |
| `actctl deprecate <ref> --grace 30d`       | 8.2b    | Mark a version deprecated with a grace window              |
| `actctl promote <ref> --env prod`          | 8.2b    | Promote a version through environments                     |
| `actctl manifest show --root <ref>`        | 8.2b    | Resolve a manifest; show the pinned versions and sha       |
| `actctl manifest in-use`                   | 8.2b    | Which manifest shas are currently being sent by clients    |
| `actctl shell`                             | 8.2b    | Admin REPL; arbitrary `await` snippets routed through call |
| `actctl actor inspect <id>`                | 8.2b    | State, recent envelopes, mailbox depth, resolved manifest  |
| `actctl migrate dry-run`                   | 8.2b    | Replay a snapshot corpus through every migration chain     |
| `actctl logs follow --actor <id>`          | 8.2b    | Tail structured logs for one actor                         |
| `actctl audit follow`                      | 8.2b    | Tail the audit log (filterable by principal / action)      |

---

## Server runtime (embedding)

For tests and embedded deployments, talk to the `Runtime` directly:

```ts
import { Runtime } from 'actjs/runtime';
import { MemoryStorageDriver } from 'actjs/storage';
import { asClassName, asVersion, mkActorId } from 'actjs/types';

const driver = new MemoryStorageDriver();
await driver.init();
const runtime = new Runtime(driver);
runtime.register({
  name: asClassName('Cart'),
  version: asVersion('1.0.0'),
  ctor: Cart,
});

const id = mkActorId();
await runtime.call(asClassName('Cart'), id, 'addItem', { sku: 'X', qty: 1 });

await runtime.shutdown();
await driver.close();
```

- `MemoryStorageDriver` is the in-process driver used by tests and
  `actctl dev`.
- `ValkeyPgStorageDriver` is the production driver (Valkey for hot
  state, PG for the durable record).

`@actjs/test` (`actjs/test` export) wraps this with a `TestRuntime`
that mints actors via `t.actor(Ctor)`, drives time deterministically
via `t.advanceTime(ms)` (fires due reminders), and ships
framework-agnostic assertions:

```ts
import { TestRuntime, assertSnapshot, assertEmitted } from 'actjs/test';

const t = await TestRuntime.create({ classes: { Cart } });
const cart = t.actor(Cart);
await cart.call.addItem({ sku: 'X', qty: 1 });
await assertSnapshot(cart, { items: [{ sku: 'X', qty: 1 }] });
await t.close();
```

`replayMigrations({ ctor, snapshots })` reports a per-snapshot diff
through the migration chain. Property-test integration (`fast-check`
arbitraries) is roadmapped to 8.2c. See [docs/testing.md](./docs/testing.md).

---

## Observability

Shipped today:

- **Logs.** `pino` via the `Logger` surface in `actjs/log`; one JSON
  line per event with `requestId`, `actorId`, `class@version`,
  `principal.sub`, `manifestSha`. Sensitive headers
  (`Authorization`, `Idempotency-Key`, capability JWT) are redacted.
  Per-subsystem env overrides (`ACTJS_LOG_LEVEL_DRIVER`, etc.); the
  driver defaults to `warn`.
- **Metrics.** `prom-client` registry exposed at `/metrics` when the
  `Runtime` is built with a `MetricsRegistry`:
  - `actjs_actor_message_total{class,method,outcome}` — method
    label allow-listed (default 50/class → `_other`).
  - `actjs_actor_active{class,version}`, `actjs_actor_mailbox_depth{class}`
  - `actjs_clients_by_manifest{sha}` (capped via the manifest tracker)
  - `actjs_manifest_resolution_seconds`
  - `actjs_event_append_total{class}`, `actjs_event_snapshot_total{class}`
  - `actjs_policy_decision_total{class,decision}`,
    `actjs_rate_limit_drop_total{subject}`,
    `actjs_capacity_exhausted_total{class}`,
    `actjs_capability_minted_total{class}`
  - Standard Node + process collectors
    See [docs/observability.md](./docs/observability.md) for the full
    runbook and starter PromQL.
- **Audit.** Every publish, deprecate, signing-key change,
  capability mint, admin RPC, and tombstone is written to the
  `audit` PG table via the strict-mode `Auditor` (best-effort opt-in).

Roadmapped (8.1b — see [tasks/ROADMAP.md](./tasks/ROADMAP.md)):

- OpenTelemetry SDK + W3C trace-context propagation through
  `Envelope.causation`.
- `ops/grafana/dashboards/` JSON bundle, `ops/prometheus/alerts.yml`,
  `compose.observability.yml`.
- S3 audit mirror (optional, append-only with object-lock).

---

## Requirements

- Node.js ≥ 20
- Valkey (or Redis) on `REDIS_URL`
- Postgres on `DATABASE_URL` (or `POSTGRES_URL`)

| Var            | Default | Purpose                    |
| -------------- | ------- | -------------------------- |
| `PORT`         | `3000`  | HTTP listen port           |
| `REDIS_URL`    | —       | Valkey hot-path connection |
| `DATABASE_URL` | —       | Postgres connection        |

Without `DATABASE_URL` the server falls back to the in-memory storage
driver with a startup warning. Suitable for tests and demos; not for
production.

---

## Scripts

| Script                  | What it does                                   |
| ----------------------- | ---------------------------------------------- |
| `npm run build`         | `tsc -b` → `dist/`                             |
| `npm run dev`           | `tsx watch src/main.ts` for hot reload         |
| `npm start`             | `node dist/main.js` (requires a prior `build`) |
| `npm run typecheck`     | `tsc --noEmit`                                 |
| `npm run lint`          | ESLint over `src/`, `tests/`, configs          |
| `npm run format`        | Prettier write                                 |
| `npm test`              | Vitest run                                     |
| `npm run test:coverage` | Vitest + v8 coverage with thresholds           |

---

## Files

| Path                                  | Purpose                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/actor.ts`                        | `Actor<S>` base class (SWM)                                                              |
| `src/event-sourced.ts`                | `EventSourced<S, E>` base class                                                          |
| `src/replica.ts`                      | `Replica<S>` opt-out-of-persistence base class                                           |
| `src/handler.ts`                      | `@handler` decorator + `getHandlers`                                                     |
| `src/types/`                          | `ActorId`, `ClassName`, `Version`, `Manifest`, `Envelope<T>`, `Principal`                |
| `src/storage/`                        | `StorageDriver` interface + memory and Valkey/PG drivers (incl. fence token)             |
| `src/runtime/`                        | `Runtime`, `ActorHost`, `Mailbox`, `ClassLoader`, reminder dispatcher                    |
| `src/registry/`                       | Resolver, publisher, manifest tracker, `MemorySigningKeyRegistry`                        |
| `src/policy/`                         | `policy()` evaluation, capability JWTs, `MemoryBlocklist`                                |
| `src/limits/`                         | `RateLimiter` (token bucket), `CapacityExhaustedError`                                   |
| `src/audit/`                          | `Auditor`, `AUDIT_ACTIONS`, strict/best-effort write modes                               |
| `src/log/`                            | `Logger` surface (pino-backed, noop, collecting), redaction list                         |
| `src/metrics/`                        | `MetricsRegistry` (prom-client) + cardinality guards                                     |
| `src/wire/`                           | JSON-RPC envelope types shared between server + client                                   |
| `src/codegen/`                        | `actctl codegen` — `.d.ts` + manifest emitter                                            |
| `src/client/`                         | `@actjs/client` — WS transport, RPC, subscriptions, offline queue                        |
| `src/bindings/`                       | `@actjs/react` + `@actjs/svelte` adapters; refcounted ActorStore                         |
| `src/cli/`                            | `actctl` CLI                                                                             |
| `src/test/`                           | `@actjs/test` — `TestRuntime`, assertions, `replayMigrations`                            |
| `src/server/`                         | Fastify app, REST routes, WS endpoint, hooks (pin, idempotency, auth)                    |
| `src/server/subscription-registry.ts` | Per-actor subscription fan-out for WS / SSE                                              |
| `migrations/`                         | Postgres schema (`0001_init`, `0002_reminders`, `0003_signing_keys`, `0004_actor_fence`) |
| `docs/`                               | Operator runbooks (auth, observability, ops-hardening, testing)                          |
| `tasks/`                              | Per-phase implementation tasks + ADRs + [ROADMAP.md](./tasks/ROADMAP.md)                 |
| `tests/`                              | Vitest unit + integration tests                                                          |
| `Dockerfile`                          | Multi-stage build, distroless final stage                                                |
| `docker-compose.yml`                  | Local stack: actjs + Valkey + Postgres                                                   |

---

## Project status

actjs is built phase-by-phase against [PLAN.md](./PLAN.md). Phases
0 through 8.2 have shipped, plus the Phase 9 cluster-seam audit;
follow-up work that was deferred from each phase is tracked in
[tasks/ROADMAP.md](./tasks/ROADMAP.md). The [CHANGELOG](./CHANGELOG.md)
is the authoritative record of what has shipped in each release;
this README describes the v1.0 surface area the PLAN targets, with
explicit roadmap markers wherever a piece is queued for a follow-up.
Per-phase task files and ADRs live in [`tasks/`](./tasks/).

Phase 9 (multi-node clustering) is sketched in PLAN.md but
deliberately not in v1. The 2026-05-20 cluster-seam audit verified
the directory boundary, idempotency, durable inbox, manifest envelope,
reminder durability, and storage driver boundary; the audit closed
three gaps (fence-token plumbing through driver + host, WS
manifest-pin capture per connection, reminders dispatcher key
parameterization) so the v2 implementation tasks (`9.1` through
`9.7`) land without rewriting earlier phases. See
[phase-9-cluster-seams.adr.md](./tasks/phase-9-cluster-seams.adr.md).
