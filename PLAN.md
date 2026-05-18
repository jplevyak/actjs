# actjs — Plan: from sketch to production actor backend

This is the roadmap that takes the current sketch
([`README.md`](./README.md), [`DESIGN.md`](./DESIGN.md)) to a complete,
versioned actor backend suitable as the server for a Svelte/React app.

## Locked design decisions

The plan below treats these as settled. They are recorded here so the
phase text doesn't keep re-justifying them.

| Decision                         | Choice                                                                     |
| -------------------------------- | -------------------------------------------------------------------------- |
| Core language                    | TypeScript everywhere (strict), ESM only                                   |
| Deployment shape                 | Self-hosted library (single-tenant default; trust your own classes)        |
| Concurrency model                | Hybrid — single-writer mailbox per actor; opt-in event sourcing per class  |
| Wire protocol                    | URL-versioned REST + JSON-RPC 2.0 over WebSocket; SSE fallback             |
| Client typing                    | Generated `.d.ts` from class TS source; OpenAPI from Fastify routes        |
| Sandbox                          | None; curated `actjs` host bridge — classes run in the host process        |
| Host parameter name              | `actjs` (rename of legacy `gact`); interface type `ActjsHost`              |
| Storage                          | Valkey (hot) + Postgres (source of truth: log, snapshots, classes)         |
| Cluster                          | Single-node v1; placement/fencing hooks kept clean for a later v2          |
| HTTP framework                   | Fastify                                                                    |
| Authoring language               | TypeScript only at publish; server transpiles for execution                |
| Version pinning per actor        | Sticky by default; `floating: true` opt-in per class                       |
| Real-time delta format           | JSON Patch (RFC 6902) for SWM actors; raw event stream for ES actors       |

Conventions used throughout:

- **SWM** = single-writer mailbox (the default actor model).
- **ES** = event-sourced (the `eventSourced: true` opt-in).
- **Manifest** = resolved map of `ClassName → SemverVersion` pinned for the
  lifetime of one root request.

For the current implementation this plan replaces, see
[`DESIGN.md`](./DESIGN.md). For what's deliberately not in scope, jump to
[*Things we are not doing*](#things-we-are-deliberately-not-doing).

---

## Guiding principles

1. **One writer per actor.** SWM is the default. Per-actor optimistic
   concurrency (today's WATCH/MULTI) doesn't scale to hot keys.
2. **Some actors are logs.** ES classes treat their stream as primary;
   state is derived. Ephemeral session state stays SWM; ledger / audit /
   workflow actors go ES.
3. **Code is data, and versioned.** Class source is a first-class entity
   with semver, content-addressed bytes, and a frozen dep graph.
4. **Compatible-version resolution end-to-end.** A request enters at an
   API version, pins a `Manifest`, and every actor-to-actor call
   downstream uses that same `Manifest`.
5. **One transport, many bindings.** REST + JSON-RPC-over-WS underneath;
   typed client and framework-specific hooks on top.
6. **Operate it like a database.** Postgres is the system of record;
   Valkey is a rebuildable cache plus liveness state. Backups, traces,
   metrics, audit log — all real.
7. **Trust your own code.** No sandbox by default. The threat model is
   "don't let a typo nuke the host," not adversarial isolation.

---

## Phase 0 — Repo health & TS conversion

**Goals.** Convert to a TypeScript repo that's pleasant to contribute to.

**Deliverables.**

- `tsconfig.json` (strict, ESM, `moduleResolution: nodenext`).
- Convert every file in the current sketch (`gact.js`, `top.js`,
  `error.js`, `main.js`, `x.js`) to `.ts`.
- Build pipeline: `tsc -b` for the engine, `tsup` for SDK packages.
- `package.json` with `engines.node: ">=20"`, lockfile committed,
  `npm ci` clean.
- Vitest test suite; coverage gate at >80% for engine code.
- `eslint` + `prettier` (thin configs).
- `Dockerfile` (multi-stage, distroless final) + `docker-compose.yml`
  pulling in Valkey + Postgres for local dev.
- GitHub Actions: lint, typecheck, test, build image, integration test
  against compose.
- `CHANGELOG.md` (Keep-A-Changelog).

**Decisions.**

- Valkey, not Redis, going forward (Redis license change). RESP-compatible
  so the client is unchanged.
- Vitest over Jest — first-class ESM, faster.

**Risks.** Pure carrying cost.

---

## Phase 1 — Domain model & types

**Goals.** Lock the vocabulary the rest of the plan uses.

**Deliverables.**

- `src/types.ts`:

  ```ts
  type ActorId      = string & { __brand: "ActorId" };       // UUIDv7
  type ClassName    = string & { __brand: "ClassName" };
  type Version      = string & { __brand: "Semver" };
  type ClassRef     = `${ClassName}@${Version}`;
  type Manifest     = ReadonlyMap<ClassName, Version>;

  interface Envelope<T = unknown> {
    id:             string;        // UUIDv7
    ts:             number;
    actor:          { id: ActorId; class: ClassName; version: Version };
    type:           string;        // method or event name
    payload:        T;
    idempotencyKey?: string;
    causation?:     string;        // envelope.id that caused this
    manifestSha:    string;
  }
  ```

- `src/actor.ts` introducing the new base:

  ```ts
  abstract class Actor<S extends object> {
    state!: S;                              // populated by runtime
    abstract onInit?(args: unknown): Promise<void> | void;
    onActivate?(): Promise<void> | void;
    onDeactivate?(): Promise<void> | void;
    snapshot(): S { return this.state; }    // override for custom serialization

    // populated by the @handler decorator below
    static readonly _handlers: Record<string, Handler>;
  }

  function handler(name?: string): MethodDecorator { /* registers in _handlers */ }
  ```

- `EventSourced<S, E>` as a parallel base class for ES actors:

  ```ts
  abstract class EventSourced<S extends object, E> extends Actor<S> {
    abstract reduce(state: S, event: E): S;
    abstract initialState(): S;
    // handlers return E[] (events to append); state is derived
  }
  ```

- `Replica<S>` remains as a marker for "in-memory derived view" actors
  (state is rebuildable from elsewhere; persistence is opt-in per
  activation).
- The four existing classes (`Actor`, `Aggregate`, `Replica`, `GAct`)
  preserved as deprecated shims that delegate to the new types so the
  current `/run` API keeps working through Phase 5.

**Decisions.**

- UUIDv7 (not v4) so actor ids are weakly sortable by creation time.
- Class identifier is `Name@Semver`. Unversioned `Name` resolves to
  "latest stable" in dev mode only; production calls must be explicit
  or carry a Manifest.
- Messages are JSON. A binary alternative (CBOR or MessagePack) is a
  future optimization, not v1.

**Risks.** Bridging old and new actor surfaces during the transition.
Budget two PRs for the shim alone.

---

## Phase 2 — Storage layer

**Goals.** Stand up the durable layout before the runtime starts writing
to it. Both SWM and ES depend on Postgres as source of truth.

### 2a. Postgres schema (source of truth)

```sql
CREATE TABLE actor (
  id              uuid PRIMARY KEY,
  class           text NOT NULL,
  version         text NOT NULL,        -- semver of the pinned class
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_active_at  timestamptz,
  tombstoned_at   timestamptz,
  tags            jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX actor_tags_gin ON actor USING gin (tags jsonb_path_ops);
CREATE INDEX actor_class_idx ON actor (class) WHERE tombstoned_at IS NULL;

CREATE TABLE actor_snapshot (
  actor_id        uuid NOT NULL REFERENCES actor(id) ON DELETE CASCADE,
  seq             bigint NOT NULL,      -- event seq this snapshot reflects (0 for SWM)
  ts              timestamptz NOT NULL DEFAULT now(),
  class_version   text NOT NULL,
  bytes           bytea NOT NULL,       -- compressed JSON
  PRIMARY KEY (actor_id, seq)
);

CREATE TABLE actor_event (                -- ES actors only
  actor_id        uuid NOT NULL,
  seq             bigint NOT NULL,
  ts              timestamptz NOT NULL DEFAULT now(),
  class_version   text NOT NULL,
  type            text NOT NULL,
  payload         jsonb NOT NULL,
  causation_id    uuid,
  PRIMARY KEY (actor_id, seq)
) PARTITION BY RANGE (ts);

CREATE TABLE class_version (
  name            text NOT NULL,
  version         text NOT NULL,
  source_sha256   bytea NOT NULL,
  deps            jsonb NOT NULL,       -- { Item: "^1.0.0", ... }
  engines         jsonb NOT NULL,
  published_at    timestamptz NOT NULL DEFAULT now(),
  deprecated_at   timestamptz,
  signed_by       text,
  signature       bytea,
  PRIMARY KEY (name, version)
);
CREATE INDEX class_version_active ON class_version (name) WHERE deprecated_at IS NULL;

CREATE TABLE class_blob (
  sha256          bytea PRIMARY KEY,
  bytes           bytea NOT NULL        -- zstd-compressed TS source
);

CREATE TABLE manifest (
  sha256          bytea PRIMARY KEY,
  resolved        jsonb NOT NULL,       -- { Cart: "1.4.2", Item: "1.0.9", ... }
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit (
  id              uuid PRIMARY KEY,
  ts              timestamptz NOT NULL DEFAULT now(),
  principal       text NOT NULL,
  action          text NOT NULL,
  target          text NOT NULL,
  meta            jsonb NOT NULL DEFAULT '{}'
);
```

### 2b. Valkey layout (hot/cache)

```
actor:<id>:hot         STRING   compressed snapshot JSON (cache; refilled from PG on miss)
actor:<id>:owner       STRING   nodeId currently owning this actor (v2 cluster only)
actor:<id>:fence       STRING   fencing token (v2)
actor:<id>:inbox       STREAM   inbound `tell` messages (durable until acked)
actor:<id>:meta        HASH     { class, version, lastActive, mailboxDepth }
reminders              ZSET     score = epoch ms, member = JSON{actorId,payload}
manifest:<sha>         STRING   resolved manifest JSON
idem:<key>             STRING   stored response, TTL 24h
class:<name>:meta      HASH     mirrored from PG for read-fast path
class:<name>:v:<ver>   HASH     mirrored from PG
blob:<sha>             STRING   compressed TS source (mirrored)
manifest_locked        SET      sha256s currently pinned by in-flight requests
```

Valkey is rebuildable: drop and reload from PG except for `reminders`
(liveness-critical) and in-flight `inbox` streams. RDB+AOF on Valkey
covers those.

### 2c. `StorageDriver` interface

A single interface backs both stores. Engine code never imports `pg` or
`redis` directly; only through the driver. This keeps Phase 9 (cluster)
and any future single-binary embedded mode possible without a rewrite.

```ts
interface StorageDriver {
  loadSnapshot(id: ActorId): Promise<{ class: ClassName; version: Version; state: unknown } | null>;
  saveSnapshot(id: ActorId, snap: SnapshotWrite): Promise<void>;
  appendEvents(id: ActorId, events: EventWrite[]): Promise<{ seq: bigint }>;
  readEvents(id: ActorId, fromSeq: bigint): AsyncIterable<EventRecord>;
  enqueueReminder(when: number, msg: ReminderMsg): Promise<void>;
  popDueReminders(now: number, limit: number): AsyncIterable<ReminderMsg>;
  publishClass(name: ClassName, version: Version, source: Buffer, deps: DepsMap): Promise<void>;
  // ...
}
```

**Decisions.**

- Postgres is the source of truth; Valkey is a (lossy) cache plus
  liveness queues. Postgres backups + WAL are sufficient for full
  recovery; Valkey RDB is a perf optimization.
- We do not implement S3 storage for snapshots in v1. If snapshots > ~64
  KiB become common we add it then.
- No pluggable storage drivers shipped beyond Valkey+PG. The interface
  exists so it's possible later; we don't pretend to support alternatives
  we don't test.

**Risks.** Postgres becomes the throughput ceiling for ES-heavy
deployments. Mitigation: `actor_event` is partitioned; we batch appends
within a mailbox turn.

---

## Phase 3 — Actor runtime

**Goals.** Implement the hybrid SWM + ES model on top of Phase 2 storage.

### 3a. `ActorHost` (the SWM owner)

- Long-lived in-process owner per active actor id.
- Holds deserialized state. For ES actors, state is reconstructed by
  `reduce(initialState, ...events)` from the latest snapshot plus newer
  events.
- Owns a serial **mailbox** (`p-queue` with `concurrency: 1`). Each
  message:
  - `call` — request/response (`Promise` returned to caller).
  - `tell` — fire-and-forget, persisted to `actor:<id>:inbox` *before*
    enqueue; acked from the stream once handled.
- Lazy `onActivate` on first message; `onDeactivate` after configurable
  idle (default 5 min).
- Persistence:
  - **SWM:** debounced `saveSnapshot` after each commit window (default
    250 ms) and on `onDeactivate`.
  - **ES:** every handler returns `E[]`; runtime calls `appendEvents`
    atomically; periodic `saveSnapshot` at every Nth event (default 100).

### 3b. Mailbox semantics & durability

- `tell` is fully durable: written to `actor:<id>:inbox` (Valkey Stream)
  before the in-memory queue. Acked after the handler returns. On crash,
  unacked messages are replayed on next activate.
- `call` is end-to-end; on crash the *caller* retries with the same
  `Idempotency-Key`. The mailbox dedupes via `idem:<key>`.
- Backpressure: per-actor inbox depth gauge; per-actor `maxMailbox`
  config; over the cap returns a `MailboxFull` error to the caller (or
  drops `tell` with a `dropped_total` counter increment).

### 3c. Reminders & timers

- `actor.scheduleAt(when, payload)` enqueues via storage driver.
- A dispatcher tick (per host, every 100 ms) pops due reminders and
  delivers them as `tell` messages to the target actor.
- Survives restarts because the ZSET (and its PG mirror) is durable.

### 3d. Migrations

- Each class version may export `async migrate(prevSnapshot, prevVersion)`
  returning the new snapshot (SWM) or `async migrateEvent(event,
  prevVersion)` returning a new-shape event (ES).
- On activate, the runtime walks the migration chain from the persisted
  `version` up to the resolved one. For ES actors, both event-level and
  snapshot-level migrations are supported.
- `actctl migrate dry-run` replays migrations against a random sample
  of live actors and reports diffs without committing.

### 3e. Hot vs cold activation

- Hot: in `actor:<id>:hot`. Skip PG read.
- Warm: snapshot in PG, no Valkey cache. Load, populate Valkey, activate.
- Cold: never activated, or tombstoned. Cold-from-events for ES means
  reading from `seq=0`.

**Decisions.**

- Replicas (in-memory derived views) are SWM actors with
  `persistOnDeactivate: false`. They de-dupe inbound subscriptions to
  upstream sources rather than being a special class.
- No cross-actor distributed transactions. If you need atomic effects
  across actors, model it as a saga: one orchestrator actor (often ES)
  emits compensating events on partial failure.

**Risks.**

- Long-running ES histories (millions of events) make cold start
  expensive. Mitigation: snapshot interval is per-class tunable;
  background `actctl compact` rebuilds snapshots offline.
- Reminder dispatcher ZSET contention. Mitigation: shard the ZSET key
  by time bucket once we cross ~10k due/sec.

---

## Phase 4 — Code versioning

**Goals.** The user requirement: classes published with semver, calls
resolve the most-recent-compatible version end-to-end.

### 4a. Publish

`POST /v1/classes/:name/versions` (admin-scoped) accepts:

```jsonc
{
  "version":  "1.4.2",                // explicit; not auto-bumped
  "source":   "<TypeScript source>",  // not compiled JS
  "deps":     { "Item": "^1.0.0", "Pricing": "~2.3.0" },
  "engines":  { "actjs": "^4.0.0" },
  "floating": false,                  // sticky by default
  "eventSourced": false               // ES opt-in
}
```

The server:

1. Validates TS compiles cleanly against `engines.actjs` types.
2. Computes `sha256`; writes `class_blob(bytes)` if new.
3. Inserts `class_version` (fails if `(name, version)` exists).
4. Emits a `class.published` event to the audit log.

Versions are immutable. Withdrawal is `PATCH .../versions/:v
{deprecated:true}` — existing resolutions still find it, new ones skip.

### 4b. Resolution

For each root request:

1. Carries either an explicit `Manifest` header (sha256 referencing a
   stored manifest) or just an API version + class+method.
2. The resolver walks the dep tree once:
   - Each node picks the highest version satisfying the range and not
     deprecated.
   - On conflict (two callers want incompatible ranges for the same
     class), the request is rejected with a structured `DepConflict`
     error showing the path.
3. The resolved Manifest is cached under its own sha256 in
   `manifest:<sha>` (and `manifest` PG table) so subsequent identical
   resolutions short-circuit.
4. The Manifest is pinned to `ctx.manifest` and threaded through every
   actor-to-actor call for the lifetime of the request.

This is what "most-recent-compatible all the way down the call stack"
means in practice: one resolution per request, identical across every
hop.

### 4c. Loader

- `ClassLoader.load(name, version)` returns the compiled module from a
  per-process LRU keyed by `sha256` (not by name; two versions coexist).
- Compilation is `swc` (fast TS → JS) the first time a sha is seen;
  module cached thereafter.
- Loading happens inside the host process (no sandbox).
- The runtime injects a curated `actjs` host object:

  ```ts
  interface ActjsHost {
    self:        ActorRef;
    call<T>(ref: ActorRef, method: string, args: unknown): Promise<T>;
    tell  (ref: ActorRef, type: string, payload: unknown): Promise<void>;
    scheduleAt(when: number | Date, type: string, payload: unknown): Promise<void>;
    now(): number;
    log:         Logger;
    manifest:    Manifest;       // read-only view of the pinned manifest
    abort(reason: string): never;
  }
  ```

  Classes never `import 'pg'` or `import 'fs'` even though they could
  — the linter forbids it, code review catches it, and the only
  *expected* I/O surface is through `actjs`.

  > **Naming note.** In the legacy sketch this parameter was called
  > `gact` and the engine class was `GAct`. The new API renames the
  > parameter to `actjs` (matching the package name) and the
  > interface type to `ActjsHost`. The legacy name is preserved
  > only inside the deprecated `/upload` + `/run` shim — see
  > *Compatibility* below.

### 4d. Sticky vs floating

- **Sticky** (default): an actor pins to the class version it was
  created with. `actor.class_version` is part of the snapshot.
  Upgrades to a sticky actor require an explicit `actctl actor migrate
  <id> <newVersion>`.
- **Floating** (per-class opt-in): on activate, the runtime picks the
  latest compatible version per the request manifest, running
  `migrate()` from the persisted version if needed.

### 4e. Client-pinned manifests

At codegen time the SDK bundle embeds the manifest sha it was built
against. Every call and WebSocket connection sends it back as
`X-Actjs-Manifest: <sha>`. When present, the server uses the stored
manifest at `manifest:<sha>` directly instead of re-resolving from
class+method ranges.

Consequences:

- An old FE bundle keeps talking to the exact class versions it was
  built against, even after the BE has published newer versions, until
  someone explicitly deprecates one of them.
- Drift becomes *observable*. The server tags every request log line
  with `manifestSha`; an aggregator turns those into a
  `clients_by_manifest{sha}` gauge (see Phase 8a), so before
  deprecating a class version the operator can check what's still in
  the wild.
- An FE bundle that pins to a sha containing a now-deprecated version
  receives a structured `VersionDeprecated` warning on first call
  (200-OK with a warning header) and a hard `Gone` error once the
  grace window expires. Both are caught by the SDK and surfaced as
  build-time hints on next deploy.

For local dev, the SDK can be configured `pin: 'latest'` to skip the
header and always re-resolve; the default in production builds is the
embedded sha.

- Code signing is *optional*. A class version may carry a signature and
  signing key id; deployments can require signatures via config
  (`requireSignedClasses: true`). Default off for self-hosted
  development.
- The unversioned reference `Name` (no `@x.y.z`) is allowed only in
  dev mode and resolves to `latest`. Production rejects it.

**Risks.**

- Class churn balloons Postgres + Valkey. Mitigation: `actctl gc`
  sweeps blobs not referenced by any non-deprecated version after a
  grace period.
- A bad migration corrupts state. Mitigation: pre-migrate snapshot is
  retained at `actor_snapshot(actor_id, -1)` for a configurable window.

---

## Phase 5 — API surface (Fastify)

**Goals.** Replace `/run` + `/upload` with a clean, versioned, typed
surface that the SDK targets.

### 5a. REST (one-shot)

```
GET    /v1/health
POST   /v1/actors/:class                 # create
GET    /v1/actors/:class/:id             # snapshot (subject to auth)
POST   /v1/actors/:class/:id/:method     # call a handler
DELETE /v1/actors/:class/:id             # tombstone
GET    /v1/actors?class=Cart&tag.userId=u_42
POST   /v1/run                           # admin-only ad-hoc script (deprecated; replaced by `actctl shell`)
GET    /v1/classes
POST   /v1/classes/:name/versions        # publish
GET    /v1/classes/:name/versions
PATCH  /v1/classes/:name/versions/:v
GET    /v1/manifest?root=Cart@1.4.2&dep=Item@^1.0.0
```

- All schemas declared with Zod; Fastify routes register Zod schemas as
  the source for both runtime validation and OpenAPI 3.1 generation.
- Errors are RFC 7807 problem-details JSON with framework codes
  (`DepConflict`, `Forbidden`, `MailboxFull`, `VersionMissing`, ...).
- Every mutating response includes `manifest: { sha256, resolved }` so
  the caller can prove which versions ran.
- `Idempotency-Key` header on mutating calls is stored at `idem:<key>`
  with the response for 24h.

### 5b. WebSocket (real-time)

`WS /v1/ws` speaks JSON-RPC 2.0:

| Method                | Direction       | Purpose                                          |
| --------------------- | --------------- | ------------------------------------------------ |
| `actor.call`          | client → server | Same as REST POST, multiplexed                   |
| `actor.subscribe`     | client → server | Subscribe to an actor                            |
| `actor.unsubscribe`   | client → server | Stop                                             |
| `actor.event`         | server → client | Notification (see below)                         |

Subscription notifications, by actor model:

- **SWM actors:** initial `snapshot` event with full state, then
  `patch` events containing a JSON Patch (RFC 6902) computed by the
  host on each committed mailbox turn.
- **ES actors:** initial `snapshot` event with state at `seq=N`, then
  one `event` per appended event (`{seq, type, payload}`). Clients
  reduce locally with the generated reducer — exact server semantics,
  no diffing fidelity loss.
- All actors: `tombstone` on destruction.

### 5c. SSE fallback

`GET /v1/actors/:class/:id/events` reuses the same event format for
clients that can't keep a WebSocket up.

### 5d. Auth — BYO hook

```ts
fastify.actjs({
  auth: async (req) => {
    // verify your token / cookie / mTLS / whatever
    return { sub: "u_42", roles: ["admin"], tenant: "default" };
  }
});
```

The framework calls `auth(req)` once per HTTP request / WS connection
and stashes the `Principal` on `req.principal`. Class `policy()`
functions (Phase 7) receive it.

**Decisions.**

- Fastify over Express. Schema-first, faster, native TS, native
  validation. The migration from Express 5 is a one-time cost paid in
  Phase 0.
- JSON-RPC 2.0 over WS rather than custom. Standard, tooling exists.
- The `/run` endpoint survives only as `actctl shell` (an admin-auth'd
  REPL against `actor.call`) — it is not part of the public API.

**Risks.** Fastify's plugin ergonomics differ from Express; the
project's mental model needs a rewrite in `docs/`.

---

## Phase 6 — Frontend SDK

**Goals.** A Svelte or React app talks to actjs as if calling local
in-memory objects.

### 6a. `@actjs/client` (TypeScript)

```ts
import { Client } from "@actjs/client";

const client = new Client({ url: "https://api.example.com", token });
const cart = client.actor("Cart", cartId);

await cart.call.addItem({ sku: "X", qty: 2 });   // idempotency-keyed
const total = await cart.get.total();
cart.subscribe((state) => render(state));        // WS under the hood
```

- Method signatures come from the generated `.d.ts` (see 6d). Calling a
  non-existent method is a compile-time error.
- One WebSocket multiplexed across all `subscribe`/`call`. Exponential
  backoff + replay on reconnect.
- **Optimistic updates** (SWM only): `cart.optimistic((draft) =>
  draft.items.push(x))` applies locally via Immer, sends the call,
  reverts on failure.
- **Offline queue:** mutations made offline persist to IndexedDB
  keyed by their `Idempotency-Key` and replay on reconnect.
- **ES clients** receive events and run the generated reducer
  client-side; the local state is byte-identical to the server's by
  construction.

### 6b. `@actjs/react`

```tsx
const cart = useActor("Cart", id);                    // Suspense for initial load
const total = useActorValue("Cart", id, c => c.total);// memoized selector
```

- Built on `useSyncExternalStore` for updates, `Suspense` for initial
  load, `useTransition` for optimistic.
- Server Components: `@actjs/react/server` exports `fetchActor(class,
  id, { manifest })` returning a serializable snapshot suitable for
  hydration.

### 6c. `@actjs/svelte`

```svelte
<script lang="ts">
  import { actor } from "@actjs/svelte";
  const cart = actor("Cart", id);
</script>
{$cart.total}
```

- Svelte 5 runes API; `$cart` is a readable store with `call`,
  `loading`, `error` siblings.

### 6d. `actctl codegen`

- Reads the published TS source of every class in the target
  deployment.
- Emits a single `.d.ts` bundle: per-class interfaces for handlers,
  per-class event payload unions, and a `Manifest`-typed constant for
  the currently pinned versions in `dev`/`staging`/`prod`.
- Emits `manifest.json` alongside the `.d.ts` — the resolved version
  map and its sha256. The SDK build embeds that sha and sends it as
  `X-Actjs-Manifest` on every call (see Phase 4e).
- Runs in CI on every publish; incremental, keyed by source sha.
- `actctl codegen --check` fails CI if the committed `client-types/`
  artifact is stale.

**Decisions.**

- Three packages instead of one umbrella: keep React/Svelte deps out
  of `@actjs/client`.
- No code is shared from the server runtime to the client beyond
  generated types. The wire surface is the contract.

**Risks.** Optimistic updates against ES actors are subtle (the client
must predict events, not state). Phase 6 ships optimistic for SWM
only; ES gets it later if there's demand.

---

## Phase 7 — Production hardening

**Goals.** Make a self-hosted deployment safe to expose to the
internet.

### 7a. Authorization

- Each class declares an optional `policy()` static:

  ```ts
  class Cart extends Actor<CartState> {
    static policy(p: Principal, action: PolicyCtx<Cart>): PolicyDecision {
      if (action.kind === "call" && action.method === "addItem") {
        return p.sub === action.actor.state.ownerId ? "allow" : "deny";
      }
      // ...
    }
  }
  ```

- A default policy DSL in YAML handles owner-only, role-match,
  tag-match cases without writing JS. Compiled to the same
  `PolicyDecision` shape.

### 7b. Capability tokens

- `actjs.mintCapability({ ttl: '1h', methods: ['read'] })` returns a
  signed short-lived JWT scoped to one actor and method set.
- Useful for shareable read links and frontend SSR without re-running
  full auth.

### 7c. Audit

- Every publish, deprecate, policy change, admin RPC, and tombstone
  goes to the `audit` PG table.
- Audit rows can be mirrored to S3 (append-only, object-lock) when
  configured.

### 7d. Code signing (optional)

- Publish accepts an `Ed25519` signature over `sha256(source) ||
  version || name`.
- Config flag `requireSignedClasses` rejects unsigned publishes.
- Allowed signing keys live in PG `signing_key`.

### 7e. Rate limits & quotas

- Per-principal token-bucket on call rate.
- Per-actor mailbox depth cap (introduced in Phase 3).
- Per-class total active actor cap.

**Decisions.**

- Multi-tenancy in the self-hosted library is a "set a prefix" feature
  (`tenantId` in the actor `tags`, filterable by index). Row-level
  isolation across tenants is out of scope.
- No SaaS billing hooks. Operators can hook the metrics they want via
  Phase 8 exports.

**Risks.** Signing keys leak. Mitigation: signing-key rotation
endpoint and the audit log makes detection straightforward.

---

## Phase 8 — Observability & DX

**Goals.** Make incidents diagnosable and the day-to-day developer
loop fast.

### 8a. Observability

- **Logs.** `pino`. One JSON line per event with `requestId`,
  `actorId`, `class@version`, `principal`, `manifestSha`.
- **Traces.** OpenTelemetry. Span per HTTP request, span per mailbox
  message, span per actor-to-actor call. W3C trace-context propagated
  through `Envelope.causation` chains.
- **Metrics.** Prometheus:
  - `actor_message_total{class,method,outcome}`
  - `actor_mailbox_depth{class}`
  - `actor_active{class,version}`
  - `clients_by_manifest{sha}` — gauge derived from request logs and
    active WS connections; lets operators see which client manifest
    shas are still in use before deprecating a class version.
  - `manifest_resolution_seconds`
  - `event_append_total{class}`, `event_snapshot_total{class}`
  - Standard Node + PG + Valkey collectors
  - Method label allow-list to prevent cardinality blowup.
- A Grafana dashboard JSON bundle ships in `ops/grafana/`.

### 8b. `actctl` CLI

- `actctl dev` — hot-reload watcher on a local class dir, republishes
  pre-release versions, drops cluster awareness for speed.
- `actctl publish`, `actctl list`, `actctl deprecate`, `actctl
  promote`.
- `actctl shell` — admin REPL: arbitrary `await` snippets routed
  through `actor.call`.
- `actctl actor inspect <id>` — current state, recent envelopes,
  resolved manifest, mailbox depth.
- `actctl manifest show --root Cart@1.4.2 --range Item@^1.0.0` — what
  *would* resolve.
- `actctl manifest in-use` — read the `clients_by_manifest` gauge and
  report which manifest shas are currently being sent by live clients,
  with the class versions each resolves to. Run this before
  deprecating a class version.
- `actctl migrate dry-run`.
- `actctl logs follow --actor <id>`.

### 8c. Testing harness

- `@actjs/test`: spin up an in-process actor host backed by an
  in-memory `StorageDriver`. Snapshot tests for handlers; property
  tests for reducers and migrations.

**Decisions.** Self-hosted Grafana stack is provided in compose for
local dev; production observability stack is the operator's choice
(Datadog, Honeycomb, vanilla Grafana — the OTel exporters cover all
of them).

**Risks.** OTel span volume from chatty actor-to-actor calls can
overwhelm a backend. Mitigation: configurable sampler, per-span-kind
caps.

---

## Phase 9 — Cluster (sketch only, deferred)

We do not build this for v1. We *do* keep the seams clean so it can
land later without rewriting earlier phases.

What is reserved for the future:

- **Placement** — consistent hashing on `actorId` over live nodes.
- **Membership** — Valkey-backed leader election or external etcd/Raft.
- **Fencing tokens** — already in the `actor:<id>:fence` Valkey key
  and `actor_snapshot.seq` invariant. Writes with stale tokens are
  refused on the storage driver boundary.
- **Hot migration** — drain mailbox, snapshot, hand owner pointer,
  resume.
- **Client routing** — nodes redirect or proxy on miss; SDK caches
  the resolved node per actor.

The `StorageDriver` interface and the `ActorHost` ownership model are
designed today such that swapping the directory from "the one node"
to "the current owner" is a localized change.

---

## Cross-cutting workstreams

### Testing

- **Engine unit tests.** All of `host.ts`, `loader.ts`, `resolver.ts`
  in isolation against an in-memory storage driver.
- **Integration tests.** Compose-spun Valkey + Postgres, exercise
  every endpoint.
- **Migration replay.** For every class, a corpus of historical
  snapshots replayed through every chain.
- **SDK contract tests.** `@actjs/client` against a running server in
  CI; reconnect, idempotency, optimistic rollback assertions.
- **Property tests.** `fast-check` on the resolver (no resolution
  picks deprecated; resolution is deterministic; conflict detection
  is complete) and on reducers (events commute where claimed).

### Documentation

- README stays usage-focused.
- DESIGN.md gets a section per phase as it ships.
- A `docs/` site (Astro Starlight) with concept guides: *Actors*,
  *Event sourcing*, *Versioning & migrations*, *Capabilities*,
  *Operating*. Doc PRs are part of the phase PRs; docs-not-shipped is
  a CI failure.

### Compatibility / migration from the current sketch

- Phase 3 makes `/upload` write both the legacy `<Name>.js` key and a
  `class_version(name, '0.0.0-legacy', ...)` record.
- Phase 5 documents `/v1/...`; `/run` is marked deprecated with a
  12-month sunset.
- Existing demo classes (`Beta`, `Gamma`) are kept working by the
  legacy shim through Phase 5.
- The host parameter rename `gact` → `actjs` is enforced only on TS
  source published via the new `POST /v1/classes/:name/versions` API.
  Legacy JS source published through `/upload` continues to receive a
  parameter named `gact` for the lifetime of the shim. A class can
  therefore live in two forms simultaneously during migration; the
  registry treats them as independent class versions.

---

## Indicative milestones

Not commitments — ordering with rough relative size.

| Phase | Relative size | Depends on | Ships independently? |
| ----- | ------------- | ---------- | -------------------- |
| 0     | S             | —          | Yes                  |
| 1     | M             | 0          | Yes                  |
| 2     | M             | 0          | Yes (just storage)   |
| 3     | L             | 1, 2       | Yes                  |
| 4     | L             | 2, 3       | Yes                  |
| 5     | L             | 1, 4       | Partial              |
| 6     | L             | 5          | Yes                  |
| 7     | M             | 5          | Mostly               |
| 8     | M             | All        | Continuously         |
| 9     | XL            | 2, 3, 7    | No (operational)     |

A small team should reach a usable demo (Svelte/React app talking to
versioned, SWM + ES actors) at the end of Phase 6. Phases 7–8 turn it
into something you'd hand to other people. Phase 9 is for the day a
single Node process is genuinely insufficient.

---

## Things we are deliberately not doing

- **A bespoke query language.** Postgres exists.
- **A bespoke RPC schema language.** TS source → `.d.ts` is the
  schema; the runtime accepts JSON.
- **WASM actor classes.** No isolation requirement in the self-hosted
  threat model. Revisit if/when a plugin-marketplace use case appears.
- **A built-in payments / users / files actor.** Framework, not BaaS.
- **Built-in CRDT support.** Opt-in for "doc"-like actors only, via
  a recipe in `docs/`. Not framework-level.
- **A SaaS control plane.** Self-hosted only; operators wire their
  own dashboards via Phase 8 exports.
- **Multi-tenancy with row-level isolation.** Single-tenant by
  default. A prefix-style tenant tag is enough; if you need stronger,
  run multiple actjs instances.
- **Cross-actor distributed transactions.** Model as sagas. Two-phase
  commit across mailboxes is a tar pit.
- **Cluster v1.** Single-node v1 only. Phase 9 keeps the seam.
