# actjs — Plan: from sketch to production actor backend

This is the roadmap that takes the current sketch (`README.md`, `DESIGN.md`)
to a complete, multi-tenant, versioned actor backend suitable as the server
for a Svelte/React app.

It is organized into nine phases. Earlier phases are load-bearing for later
ones, but most phases are individually shippable: each ends with a system
that does more than the previous one and is still coherent on its own. Each
phase block lists *Goals*, *Deliverables*, *Design decisions*, and *Risks /
open questions*.

For the existing implementation this plan replaces, see [`DESIGN.md`](./DESIGN.md).

---

## Guiding principles

These shape every phase below.

1. **Single-writer per actor.** Optimistic concurrency at the actor level
   (today's WATCH/MULTI/EXEC) doesn't scale to hot keys. We move to one
   logical writer per actor with a serialized mailbox. Cross-actor
   transactions remain optimistic.
2. **Code is data, and versioned.** Class source is a first-class entity
   with semver, content-addressed bytes, and a resolved dep graph.
   Deployments are version publishes; rollbacks are atomic.
3. **Compatible-version resolution end-to-end.** A request enters at an
   API version, pins a *manifest* of resolved class versions, and every
   actor-to-actor call uses that pinned manifest. Compatibility is npm-
   style semver ranges (`^1.2.0`, `~2.3.0`, exact).
4. **The wire protocol is one thing.** A single typed RPC surface that
   serves HTTP, WebSocket, and SSE clients — not three parallel APIs.
5. **TypeScript-first from the SDK out.** The framework is JS, but the
   user-facing surface (CLI, client SDK, generated types) is TS.
6. **Operate it like a database.** Snapshots, WAL, point-in-time restore,
   metrics, traces, structured logs, audit log — all of it.

---

## Phase 0 — Repo health

**Goals.** Make the codebase a project you'd join, not a sketch.

**Deliverables.**

- `package.json` with `engines`, lockfile committed, `npm ci` clean.
- TypeScript across the board (`*.ts`) with strict mode; ESM only.
- Vitest test suite running on commit; coverage gate at >80% for engine code.
- `eslint` + `prettier` with a thin config; no formatting churn in reviews.
- `Dockerfile` (multi-stage, distroless final), `docker-compose.yml`
  pulling in Valkey for local dev.
- GitHub Actions: lint, typecheck, test, build image, integration test
  against compose.
- `CHANGELOG.md` with Keep-A-Changelog conventions.

**Decisions.**

- Valkey not Redis going forward (Redis license change). Wire protocol
  remains RESP, so the client is unchanged.
- Vitest over Jest — first-class ESM, faster.

**Risks.** Pure carrying cost; none real.

---

## Phase 1 — Domain model & types

**Goals.** Lock the vocabulary the rest of the plan uses.

**Deliverables.**

- `src/types.ts` defining:
  - `ActorId = string` (UUIDv7, time-orderable).
  - `ClassName = string`, `Version = SemverString`, `ClassRef = "${ClassName}@${Version}"`.
  - `Manifest` — resolved map of `ClassName → Version` for one request.
  - `Envelope<T>` — the wire format of every actor write
    (`{ id, type, ts, actor: { id, class, version }, payload: T, idempotencyKey, causation }`).
  - `Mailbox`, `Reminder`, `Subscription`, `Capability` — see Phases 2/4/8.
- `src/actor.ts` introducing the `Actor` base class as a typed interface
  with `onInit`, `onActivate`, `onDeactivate`, `onMessage`, `snapshot`,
  and a `handler` registry decorator (`@handler('addItem')`).
- The four existing classes (`Actor`, `Aggregate`, `Replica`, `GAct`)
  preserved as deprecated shims that delegate to the new types so the
  current `/run` API keeps working through Phase 4.

**Decisions.**

- UUIDv7 (not v4) so actors are weakly sortable by creation time, and so
  Redis cluster hash slots distribute newer actors well.
- Class identifier is `Name@Semver`, not `Name`. The unversioned form is
  reserved for "latest stable" in dev mode only.
- Messages are JSON for now (Phase 6 introduces a binary alternative).

**Risks.** Bridging old and new actor surfaces during the transition will
take longer than it looks. Budget two PRs for the shim alone.

---

## Phase 2 — Single-writer actor runtime

**Goals.** Remove optimistic concurrency from the per-actor write path.

**Deliverables.**

- `ActorHost` — a long-lived in-process owner for an actor:
  - Holds the actor's deserialized state.
  - Owns a serial **mailbox** (`p-queue` with concurrency=1).
  - Calls `onActivate` lazily on first message, `onDeactivate` after an
    idle timer expires.
  - Persists state to Valkey by SETting `<actorId>` on a debounced
    schedule and on deactivate.
- **Actor directory.** A process-local map `ActorId → ActorHost` plus
  a Valkey hash `actor:owner` mapping `ActorId → nodeId`. Phase 7
  upgrades this for cluster routing.
- **Mailbox semantics.** A message is either:
  - `call` — request/response (await result).
  - `tell` — fire-and-forget, persisted to a per-actor stream.
- **Reminders & timers.** `actor.scheduleAt(when, payload)` writes to a
  global ZSET keyed by epoch ms; a dispatcher tick pops due items and
  delivers as messages. Survives restarts.
- **Backpressure.** Mailbox depth metrics; per-actor cap with
  `429`-equivalent if exceeded.

**Decisions.**

- Cross-actor transactions stay optimistic (they're rare). Per-actor
  serialization replaces WATCH/MULTI for the common case.
- We do not use Redis Streams for the mailbox in Phase 2 — the queue is
  in-process and only persisted when an actor is hot. Reminders are the
  one durable queue.
- Snapshots go through `JSON.stringify` by default; `actor.snapshot()`
  can override for cases that need custom serialization.

**Risks.**

- Owner reassignment after a node death — Phase 7 handles this with a
  fencing token. Phase 2 ships with single-node assumption.
- Mailbox loss on crash if state is debounced but messages are in flight.
  Mitigation: also append every inbound `tell` to a per-actor Valkey
  Stream and replay on activate. (`call` is end-to-end; the caller
  retries.)

---

## Phase 3 — Code as data, with versions

**Goals.** Make class source a first-class, versioned, content-addressed
entity. This is the heart of the user's stated requirement.

### 3a. Storage layout

```
class:<Name>:meta              HASH   { latest, deprecated, owner, ... }
class:<Name>:versions          ZSET   semver → publishedAt
class:<Name>:v:<Semver>        HASH   { sha256, deps, signature, signedBy, publishedAt }
blob:<sha256>                  STRING source (compressed)
manifest:<sha256>              STRING JSON of resolved tree for that root sha
```

Source is stored once per content hash. A class version is a small record
pointing at a blob plus a frozen dependency list:

```jsonc
// class:Cart:v:1.4.2
{
  "sha256":   "ab12…",
  "deps":     { "Item": "^1.0.0", "Pricing": "~2.3.0" },
  "engines":  { "actjs": "^4.0.0" },
  "signedBy": "key:ops-prod",
  "signature":"…",
  "publishedAt": 1737000000000
}
```

### 3b. Publishing

- `POST /v1/classes/:name/versions` (admin-scoped) accepts source +
  declared deps + semver bump. Server computes the sha256, refuses if a
  conflicting version already exists, writes to `blob:` and `class:`.
- Versions are immutable. Withdrawal is a separate flag
  (`deprecated: true`); EXISTING resolutions still find it, NEW
  resolutions skip it.
- A `latest` tag on `class:<Name>:meta` points to the highest
  non-deprecated stable version (no `-rc.*` prefix).

### 3c. Resolution

Given a *root request* (`POST /v1/run` or `POST /v1/actors/<id>/call`):

1. The request carries either an explicit `Manifest` header, or just an
   API version (e.g. `v1`) plus the class+method.
2. The resolver walks the dep tree once and produces a `Manifest`:
   `{ "Cart": "1.4.2", "Item": "1.0.9", "Pricing": "2.3.4", ... }`.
   - Each node picks the highest version satisfying the range and not
     marked deprecated.
   - On conflict (two callers want incompatible ranges for the same
     class), the request is rejected with a structured `DepConflict`
     error showing the path.
3. The resolved `Manifest` is cached in Valkey under its own sha256
   so subsequent calls with the same inputs reuse it.
4. The Manifest is attached to the request context (`ctx.manifest`) and
   pinned for the lifetime of the request — every actor-to-actor call
   downstream uses the same resolution.

### 3d. Loading classes safely

- `ClassLoader.load(name, version, ctx)` returns the constructor for
  `Name@Version` from a per-process LRU keyed by `sha256` (not by name,
  so two versions coexist).
- The loader compiles the source inside a `worker_threads` Worker per
  class version (Phase 5 swaps this for `isolated-vm`). Multiple actors
  of the same `Name@Version` share one Worker.

### 3e. Sticky vs floating actors

- **Sticky.** Once activated, an actor keeps running the version it was
  created with until explicitly migrated. Stored at `actor:<id>:meta`
  as `{ class, version }`. This is the default — guarantees stability.
- **Floating.** Opt-in per class (`floating: true` in class meta). The
  runtime upgrades the running version to the latest compatible on each
  activate.

### 3f. Migrations

- Each version may export `async migrate(prevSnapshot, prevVersion)` →
  new snapshot. On activate, if the persisted snapshot's version is
  older than the target version, the runtime walks the migration chain
  in order. Migrations are idempotent and pure.
- A `dry-run` admin endpoint replays migrations against a sampled set
  of actors before rollout.

**Deliverables.** Implementation of 3a–3f, `actctl publish/list/deprecate
/promote`, frontend dev mode that hot-reloads classes via the publish API.

**Decisions.**

- We embed the resolver, rather than depending on `npm`. The graph is
  small, runs per request, and has framework-specific rules (deprecation
  filtering, signing).
- Source bytes are content-addressed *with compression* (`zstd` over the
  raw source) so blobs dedupe and stay small.
- We do not invent a new dependency syntax — we use exact semver ranges
  exactly as npm does.

**Risks.**

- Version churn explodes Valkey memory. Mitigation: an `actctl gc`
  command sweeps blobs no `class:*:v:*` references, after a grace
  period.
- A misbehaving migration corrupts state. Mitigation: snapshot the old
  state at `actor:<id>:premigrate:<fromV>` for a configurable window.

---

## Phase 4 — API surface

**Goals.** Replace `/run` and `/upload` with a clean, versioned, typed
HTTP/WebSocket API.

### 4a. HTTP REST

Versioning lives in the URL path. The version refers to *API shape* not
class shape — class versions are negotiated independently.

```
GET    /v1/health
POST   /v1/actors/:class                 # create
GET    /v1/actors/:class/:id             # snapshot (subject to auth)
POST   /v1/actors/:class/:id/:method     # call a handler
DELETE /v1/actors/:class/:id             # destroy
POST   /v1/run                           # ad-hoc script (admin-only)
GET    /v1/classes
POST   /v1/classes/:name/versions        # publish (admin)
GET    /v1/classes/:name/versions
PATCH  /v1/classes/:name/versions/:v     # deprecate/promote
```

- Request body is JSON; method arguments are positional in an `args`
  array or named in `params`.
- Response includes a `manifest` field listing the resolved versions
  used for that call. Clients with cache keys based on `(method, args,
  manifest)` can reason about staleness.
- Errors are RFC 7807 problem-details JSON with framework-specific
  extensions (`code: "DepConflict" | "Forbidden" | "MailboxFull" | ...`).

### 4b. WebSocket

Single endpoint, JSON-RPC 2.0:

```
WS /v1/ws
```

Methods are `actor.call`, `actor.subscribe`, `actor.unsubscribe`. The
server pushes `actor.event` notifications for active subscriptions.
Subscriptions deliver three event types:

- `snapshot` — initial state on subscribe.
- `patch` — JSON Patch (RFC 6902) from previous state.
- `tombstone` — actor destroyed.

This is the same transport used by the SDK's reactive bindings (Phase 5).

### 4c. SSE

`GET /v1/actors/:class/:id/events` as a fallback for environments that
can't keep a WebSocket up (mobile background, restrictive proxies).

### 4d. Idempotency

Every mutating call accepts `Idempotency-Key`. Stored in Valkey at
`idem:<key>` with the response for 24h; replays return the original
response untouched.

**Deliverables.** Express router rewrite (or move to Fastify — see Risks),
OpenAPI 3.1 document generated from the router, contract tests against
the generated doc.

**Decisions.**

- Fastify *is* materially faster than Express 5 for JSON workloads and
  has first-class TypeScript. We move to Fastify in 4 if Phase 0
  hasn't already.
- JSON-RPC 2.0 over WebSocket rather than custom — tooling exists,
  semantics are clear, browsers + Node both have libraries.

**Risks.** Migrating off Express deletes a lot of muscle memory. Worth
it but takes a sprint.

---

## Phase 5 — Frontend SDK

**Goals.** Make a Svelte or React app feel like it's talking to local
in-memory objects.

### 5a. `@actjs/client` (TypeScript)

```ts
import { Client } from "@actjs/client";

const client = new Client({ url: "https://api.example.com", token });
const cart = client.actor("Cart", cartId);

await cart.call.addItem({ sku: "X", qty: 2 });   // idempotent if key set
const total = await cart.get.total();
cart.subscribe((state) => console.log(state));   // WebSocket under the hood
```

- Method signatures come from generated `.d.ts` (see 5d).
- The client multiplexes calls and subscriptions over one WebSocket
  with automatic reconnect + exponential backoff + replay.
- Optimistic updates: `cart.optimistic((draft) => draft.items.push(x))`
  applies locally, sends, reverts on failure.
- Offline queue: mutations made offline persist to IndexedDB and replay
  on reconnect with their original `Idempotency-Key`.

### 5b. React bindings — `@actjs/react`

```tsx
const cart = useActor("Cart", id);
const total = useActorValue("Cart", id, c => c.total);  // selector + memo
```

Hooks use Suspense for initial load and `useSyncExternalStore` for
updates. Server components: a sibling `@actjs/react/server` exports
`fetchActor` that uses the HTTP API and returns a serializable snapshot.

### 5c. Svelte bindings — `@actjs/svelte`

```svelte
<script>
  import { actor } from "@actjs/svelte";
  const cart = actor("Cart", id);
</script>
{$cart.total}
```

Stores expose `subscribe` (live), `call` (mutate), and a `loading`/
`error` triplet.

### 5d. Code generation

`actctl codegen` reads every published class's TypeScript source (we
require classes to be authored in TS from Phase 3 on) and emits a
`.d.ts` bundle with:

- One interface per actor class describing handlers.
- One union of all event payload shapes.
- A `Manifest`-typed value for the currently-pinned versions in
  dev/staging/prod, so editors flag breaking method removals before
  publish.

**Deliverables.** Three NPM packages (`@actjs/client`,
`@actjs/react`, `@actjs/svelte`), a generated types package per
deployment, a `create-actjs-app` starter.

**Decisions.** Svelte 5's runes API; React 19's `useSyncExternalStore`
+ Suspense; both via the same underlying `Client`.

**Risks.** Code generation runs every publish — slow CI. Mitigation:
incremental, only regenerate for classes whose source hash changed.

---

## Phase 6 — Storage layer

**Goals.** Move from "everything is a Valkey key" to a layered store
that separates hot, warm, and cold paths.

### 6a. Hot path (Valkey)

- Active actor state, the actor directory, reminders, idempotency
  cache, manifest cache. RAM-resident; small.

### 6b. Warm path — append-only log

Per actor, a stream `actor:<id>:log` of every committed message envelope.
Used for:

- Replay on cold-start (state = `snapshot ⊕ tail-since-snapshot`).
- Audit log.
- Event sourcing for actors that opt in (`eventSourced: true` on the
  class; the framework persists *only* the log, deriving state via
  reducers).

### 6c. Cold path — Postgres + object store

- Postgres tables:
  - `actor` — id, class, version, created_at, last_active_at, tags.
  - `actor_snapshot` — id, version, ts, sha256, bytes (or pointer).
  - `actor_event` — partitioned by month for retention.
  - `class_version`, `class_blob`, `manifest` — mirror of Valkey state
    as the source of truth.
- S3-compatible object store for snapshot bytes larger than ~64 KiB.
- A background reaper moves cold actors out of Valkey, leaving a
  tombstone with the Postgres pointer. Reads warm them back.

### 6d. Indexing & query

- Actors carry user-defined `tags: Record<string, string>`. Tags are
  indexed in Postgres so the API can do `GET /v1/actors?class=Cart&
  tag.userId=u_42`.
- We do *not* invent a query language. For anything richer than tag
  match, use Postgres directly via a read replica.

### 6e. Backups & PITR

- Postgres logical backups, hourly.
- Daily Valkey RDB to object store.
- Reminders ZSET separately, since it's the only liveness-critical
  Valkey-only state.

**Decisions.** Postgres over a fancier multi-model DB — operationally
boring, has ecosystem.

**Risks.** Sync drift between Valkey and Postgres. Mitigation: Postgres
is the source of truth for everything *except* hot state; Valkey is a
cache rebuilt from the log if it loses data.

---

## Phase 7 — Cluster

**Goals.** Run more than one node. Survive node death.

### 7a. Placement

- Consistent hashing on `actorId` over the set of live nodes.
- Membership via a Valkey-backed leader election (Phase 8 swaps to
  Raft/etcd if needed).
- Each node owns the actors hashed to it and rejects calls for actors
  it doesn't own with a `307` to the correct node.

### 7b. Fencing

- `ActorHost.activate` takes a monotonically increasing fencing token
  from a Valkey `INCR`. Persisted snapshots include the token. Writes
  with stale tokens are refused — guards against split-brain after a
  network partition.

### 7c. Hot migration

- On rebalance (node joins/leaves), affected actors are gracefully
  evicted: drain mailbox, snapshot, hand owner pointer to new node,
  resume there.

### 7d. Client routing

- Clients hit any node; nodes redirect or proxy. The SDK caches the
  resolved node per actor with a short TTL.

**Risks.** Owner mapping in Valkey is the single point of contention
on rebalance. Mitigation: gossip the placement table and only consult
Valkey on miss.

---

## Phase 8 — Security, auth, multi-tenant

**Goals.** Ship to real users.

### 8a. Authentication

- OAuth/OIDC for end users; signed JWTs validated on every call.
- Service-to-service: mTLS or HMAC-signed JWTs.
- Admin: separate audience, requires hardware-key MFA at the IdP.

### 8b. Authorization

- Per-class `policy()` function decides whether a caller may invoke a
  given method on a given actor. Receives the principal, the actor's
  state, and the method+args. Pure function, evaluated on the host.
- A default policy DSL handles 90% of cases (owner-only, role match,
  tag match) without writing JS.

### 8c. Capabilities

- Actor references can be minted as capability tokens: short-lived
  signed payloads granting one principal the ability to call a
  specific actor (`actor.mintCapability({ ttl: '1h', methods: ['read'] })`).
  Frontends use these for shareable read links without a full auth flow.

### 8d. Multi-tenancy

- A `tenantId` claim on every JWT scopes class lookup, actor lookup,
  and storage. Tenants are isolated at the Valkey key prefix and the
  Postgres row level. Cross-tenant calls require an explicit grant
  recorded in `tenant_grant`.

### 8e. Sandboxing user code

- Replace `worker_threads` with `isolated-vm` per class version. CPU
  and memory caps enforced. No `fs`, no `net`, no `process` — only
  the `gact` host object.
- A capability-style bridge exposes a curated set of host calls
  (`gact.load`, `gact.call`, `gact.now`, `gact.log`, etc.).

### 8f. Audit

- Every publish, deprecate, policy change, admin RPC, and actor
  destroy goes to an append-only audit log (own Postgres table +
  immutable S3 mirror).

**Decisions.** `isolated-vm` is the only realistic in-process sandbox
for V8. If its maintenance status worsens we move to per-tenant
processes.

**Risks.** `isolated-vm` requires native build and lags Node versions.
Pin Node deliberately.

---

## Phase 9 — Observability & ops

**Goals.** Make incidents diagnosable.

**Deliverables.**

- Structured logs (`pino`), one JSON line per event, with request id,
  actor id, class version, tenant.
- OpenTelemetry traces — span per HTTP request, span per mailbox
  message, span per actor-to-actor call. W3C trace-context propagated
  through Envelopes.
- Prometheus metrics:
  - `actor_message_total{class,method,outcome}`
  - `actor_mailbox_depth{class}`
  - `actor_active{class,version}`
  - `manifest_resolution_seconds`
  - `valkey_*`, `pg_*`, `nodejs_*` standard sets.
- Per-class dashboards generated from a template.
- SLO definitions in the repo: `p99 call latency < 250ms`, `error
  rate < 0.1%`, with burn-rate alerts.
- Runbook stubs for the top ten failure modes the design anticipates.

**Decisions.** Self-hosted Grafana stack in compose for local; vendor
choice deferred to the deploying operator.

**Risks.** Cardinality explosion if `method` becomes a high-cardinality
label. Phase-9 PR includes a method-allowlist guard.

---

## Cross-cutting workstreams

These run alongside the phases, not in sequence.

### Testing strategy

- **Engine unit tests.** All of `gact.ts`, `loader.ts`, `resolver.ts`
  in isolation against a fake Valkey.
- **Integration tests.** Compose-spun Valkey + Postgres, one process,
  exercise every API endpoint.
- **Multi-node tests.** Three-node compose, network partition via
  toxiproxy, asserts on fencing token invariants.
- **Property tests.** `fast-check` on the resolver (no resolution
  picks deprecated; resolution is deterministic; conflict detection
  is complete).
- **Migration replay tests.** For every class, a corpus of historical
  snapshots replayed through every migration chain.
- **SDK contract tests.** `@actjs/client` against a running server in
  CI; assertions on reconnect behavior, idempotency, optimistic
  rollback.

### Developer experience

- `actctl` CLI: `dev`, `publish`, `deploy`, `migrate dry-run`,
  `logs follow`, `actor inspect`, `actor call`, `manifest show`.
- `actctl dev` runs a single-process server with hot-reload (watches
  the local class source dir and republishes pre-release versions).
- VS Code extension (later): inline manifest resolution preview,
  jump-to-actor.

### Documentation

- README stays usage-focused.
- DESIGN.md stays implementer-focused; gets a section per phase as
  shipped.
- A separate `docs/` site (Astro Starlight) with concept guides:
  *Actors*, *Versioning*, *Migrations*, *Capabilities*, *Operating*.

### Compatibility / migration from current sketch

Until Phase 4 ships, the `/run` and `/upload` endpoints keep working
unchanged behind a deprecation warning. Anyone already using the
sketch can migrate one class at a time. The cutover plan:

1. After Phase 3 lands, `/upload` writes both the legacy
   `<Name>.js` key and a `class:<Name>:v:0.0.0-legacy` record.
2. After Phase 4 lands, `/v1/...` is documented; `/run` is marked
   deprecated with a 12-month sunset.
3. Phase 7+ assumes only `/v1/...` exists.

---

## Indicative milestones

These are *not* commitments — they're ordering with rough relative size.

| Phase | Relative size | Depends on    | Ships independently? |
| ----- | ------------- | ------------- | -------------------- |
| 0     | S             | —             | Yes                  |
| 1     | M             | 0             | Yes                  |
| 2     | L             | 1             | Yes                  |
| 3     | XL            | 1, 2          | Yes                  |
| 4     | L             | 1, 3          | Yes (limited)        |
| 5     | L             | 4             | Yes                  |
| 6     | L             | 2, 3          | Partial              |
| 7     | XL            | 2, 6          | No (operational)     |
| 8     | L             | 4             | Mostly               |
| 9     | M             | all           | Continuously         |

A small team should be able to take Phases 0–4 to a usable "Svelte/React
app talks to versioned actors" demo. Phases 5–9 turn it into something
you'd run for paying customers.

---

## Things we are deliberately not doing

Listed so they don't get rediscovered as "missing":

- **A bespoke query language.** Postgres exists.
- **A bespoke RPC schema language.** TypeScript source → `.d.ts` is the
  schema; the runtime accepts JSON.
- **A blockchain / CRDT story.** Single-writer per actor is enough; if
  you need geo-replicated convergence you can build it inside an actor
  using Y.js or Automerge, but it isn't framework-level.
- **WASM actor classes (yet).** `isolated-vm` is faster to ship and
  covers the threat model. Revisit when we have a non-JS author with
  real demand.
- **A built-in payments / users / files actor.** This is a framework,
  not a backend-as-a-service. Examples in `docs/` show how to build
  these in 50 lines.
