# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed — GAct legacy shim sunset

- **Deleted** `src/gact.ts`, `src/legacy/shim.ts`, `src/server/routes/legacy.ts`, and the `src/legacy/` directory. The pre-Phase-1 GAct API and the `POST /run` / `POST /upload` routes are gone. The actor framework (`Actor`, `EventSourced`, `Replica`, `@handler`, `Runtime`) is the sole supported surface.
- **Removed** the `./legacy` subpath export from `package.json`, the `demo` npm script, `demo.bash` + its sibling demo payload files (`demo1_*`, `demo2_*`, `demo3_*`, `Beta.js`, `Gamma.js`).
- **Removed** `BuildAppOptions.redisUrl` — it was only consumed by the legacy routes. The `ValkeyPgStorageDriver`'s own `redisUrl` option is unchanged.
- **Removed** the CI "Integration (demo.bash)" job; the lint / typecheck / test / build / docker / storage-conformance jobs continue unchanged.
- **Removed** `tests/gact.test.ts`, `tests/shim.test.ts`, and the `admin.rpc` / `legacy /run requires admin` assertions inside `tests/audit/integration.test.ts` and `tests/server/auth.test.ts`. The audit-action constant `AUDIT_ACTIONS.ADMIN_RPC` is kept as a placeholder for a future admin RPC route.
- **Why now:** the shim existed for backward compat with a pre-actjs library that was never published to npm. Sunsetting before the first npm publish (`@jplevyak/actjs@0.3.0`) means no downstream breakage and the package never ships the legacy surface.

### Added — Phase 5.2 (WebSocket / JSON-RPC)

- **`/v1/ws` endpoint** speaking JSON-RPC 2.0. Methods:
  - `actor.call(class, id, method, args)` → `{result}`.
  - `actor.subscribe(class, id)` → `{subscriptionId}`. Server immediately replies with an `actor.event` notification of kind `snapshot`.
  - `actor.unsubscribe(subscriptionId)` → `{ok}`.
- **`actor.event` notifications** delivered per-subscription:
  - `snapshot` — full state, sent once on subscribe.
  - `patch` — RFC 6902 JSON Patch ops generated via `fast-json-patch` against the prior state (SWM actors).
  - `event` — the events appended in the commit + the running ES `seq` as a decimal string (ES actors).
  - `tombstone` — sent on DELETE; the subscription is dropped immediately after.
- **`SubscriptionRegistry`** (`src/server/subscription-registry.ts`) decouples subscription bookkeeping from the WS transport. Per-actor cap defaults to 1000 (configurable via `buildApp({ maxSubscribersPerActor })`); over the cap `actor.subscribe` rejects with JSON-RPC error code `-32000` + `data.code: 'SubscriberLimit'`.
- **Commit hooks on `ActorHost`** — `onCommit(listener)` returns an unsubscribe fn; SWM emits `{kind: 'patch', patch, state}` via a pre-handler `structuredClone` + post-commit `compare`, ES emits `{kind: 'event', events, seq, state}`. `notifyTombstone()` is invoked by `runtime.tombstone(id)`, which the DELETE route now uses so subscribers see the tombstone before the durable mirror is updated.
- **Heartbeat** — server pings every 30s; the connection is closed with code `1001 heartbeat timeout` if no pong arrives within 90s. Override via `wsPingIntervalMs` / `wsPingTimeoutMs` on `buildApp`.
- **bigint serialization** — the runtime's `seq` is sent as a decimal string in `actor.event` params (`seq?: string`). JSON-RPC payloads carry no bigint values.
- **Plugins added**: `@fastify/websocket`, `fast-json-patch`.

### Deferred (Phase 5.2)

- **Reconnect / replay window.** A flaky client gets a fresh `snapshot` on reconnect; resume-from-seq belongs to the Phase 6.2 SDK + a follow-up runtime hook.
- **Manifest pin over WS.** Pin validation today runs only on REST. Phase 5.4 will close this together with per-call activation-against-pin.
- **Patch-vs-snapshot byte heuristic.** v1 always sends patches; a metric in Phase 8.1 will measure where the heuristic would fire before we implement it.

### Changed — Phase 5.1 (Fastify + REST)

- **Express → Fastify.** The HTTP layer is now Fastify with the Zod type provider; routes are validated and typed end-to-end from their Zod schemas. Express, multer, and their `@types/*` packages were removed from `dependencies`.
- **Server reorganized** under `src/server/`:
  - `app.ts` — `buildApp({driver, runtime, ...})` factory.
  - `errors.ts` — RFC 7807 problem-detail mapper covering every framework exception (DepConflict, MailboxFull, ManifestRegression, ClassVersionExpired/Gone, SchemaInvalid, ForbiddenImport, …). Responses use `application/problem+json`.
  - `hooks/pin.ts` — port of the Phase 4.3 pin middleware to a Fastify preHandler. Returns 400 `ManifestUnknown` / 410 `Gone` / 200 with `Warning: 299`.
  - `hooks/idempotency.ts` — `Idempotency-Key` preHandler + onSend pair. 24h TTL via the storage driver. Replayed responses set `Idempotency-Replayed: true` and echo the original key.
  - `routes/health.ts`, `routes/classes.ts`, `routes/manifest.ts`, `routes/admin.ts`, `routes/actors.ts`, `routes/legacy.ts`.
- **New actor REST routes**:
  - `POST   /v1/actors/:class` — mint a fresh actor id.
  - `GET    /v1/actors/:class/:id` — return the actor's snapshot (404 `ActorNotFound` when none).
  - `POST   /v1/actors/:class/:id/:method` — invoke a handler; response carries `{class, id, method, result, manifest?}`.
  - `DELETE /v1/actors/:class/:id` — tombstone.
- **New `GET /v1/health`** + OpenAPI 3.1 doc at `GET /openapi.json` via `@fastify/swagger`. The committed snapshot at `tests/fixtures/openapi.json` is byte-compared on every test run; refresh with `UPDATE_OPENAPI=1 npm test`.
- **Legacy routes ported** (`GET /`, `POST /run`, `POST /upload`) so `demo.bash` keeps working. The legacy `gact.ts` runtime is unchanged.
- `top.ts` was rewritten — fewer than 50 lines. Boots a `ValkeyPgStorageDriver` when `DATABASE_URL` is set, otherwise a `MemoryStorageDriver` with a startup warning.

### Deferred (cross-phase)

- **Per-call activation against the pinned manifest.** Phase 4.3 carved this out for Phase 5.1; it turned out to cut across Phase 4.2's sticky/floating logic and double the size of this phase. Pin is validated + observed today; threading the manifest into `runtime.call` activation is queued for a Phase 5.4 follow-up.

### Added — Phase 4.3 (Client-pinned manifests)

- **`ManifestUsageTracker`** (`src/v1/manifest-tracker.ts`): in-process per-sha counter + lastSeen, with a top-N (default 128) cap that rolls overflow into an `_other` bucket. Reports include the resolved version map for each sha. Phase 8.1 will surface this as `clients_by_manifest{sha}` Prometheus gauge.
- **Pin middleware** (`src/v1/pin-middleware.ts`): reads `X-Actjs-Manifest`, validates against `driver.loadManifest`, records into the tracker, classifies every pinned `(class, version)` for deprecation state, and applies the lifecycle semantics:
  - Unknown sha → **400** `ManifestUnknown` (short-circuits).
  - Pin references a version past `grace_until` → **410 Gone** with the offending refs.
  - Pin references a deprecated-but-in-grace version → request proceeds; response carries `Warning: 299 - "VersionDeprecated <refs>"`.
  - Valid pin → `req.manifestPin` populated for downstream handlers.
  - lastSeen is updated via a 1/100 sampled `driver.saveManifest` call (no extra writes per request).
- **New routes**:
  - `GET /v1/manifest/:sha` — retrieve a stored manifest by its sha.
  - `GET /v1/admin/manifests/in-use` (admin) — returns the tracker report; this is what `actctl manifest in-use` will call (Phase 8.2).
- `registerV1Routes(app, driver, options?)` now returns `{ tracker }` so the same tracker can be threaded into Phase 8.1 metrics.
- **Loader grace-window backstop**: `ClassLoader.load` refuses to load a class version whose `graceUntil` has passed (new `ClassVersionExpired` error). The pin middleware returns 410 before that path is reached; this is the runtime safety net for direct registration code paths.
- 13 new tests across `tests/v1/manifest-tracker.test.ts`, `tests/v1/manifest-pin.test.ts`, and `tests/runtime/loader-grace.test.ts`.

### Added — Phase 4.2 (Loader & version policy)

- **`ClassLoader`** (`src/runtime/loader.ts`): fetches TypeScript source from the storage driver, transpiles via `ts.transpileModule`, evaluates the JS as the body of `async function (actjs) { ... }` with `CLASS_KIT` injected, returns the class constructor. LRU cache keyed by `sha256(source)` (cap 256, refcount-aware so live-actor entries are never evicted; also skips the just-inserted entry to prevent self-eviction under one-cap-one-refcount loads). New errors: `ClassSourceNotFound`, `CompileError`.
- **`CLASS_KIT`** (`src/runtime/class-kit.ts`): frozen object exposing `Actor` / `EventSourced` / `Replica` / `handler`. This is the _compile-time_ `actjs` — distinct from the per-instance `this.actjs` bridge below.
- **Host bridge** (`src/runtime/host-bridge.ts`): `ActjsHost` interface + `makeBridge(options)`. Methods: `self`, `call`, `tell`, `scheduleAt`, `now`, `log`, `abort` (throws `ActorAbort`). Outbound `call` / `tell` / `scheduleAt` are injected callbacks; the bridge has no direct Runtime reference, so unit tests can omit `outbound` and the bridge falls back to a thrower.
- **`Actor.actjs`** field — populated by `ActorHost` on activation; handlers use `this.actjs.call(...)` etc.
- **Sticky-by-default activation** in `ActorHost`:
  - `ActorClassRegistration.floating?: boolean` (default `false`).
  - On activate, `resolveCtor(persisted)` picks the constructor:
    - persisted == registered → registered ctor.
    - persisted < registered + floating: false (sticky default) → load older ctor via `ClassLoader`.
    - persisted < registered + floating: true → registered ctor + run `migrate`.
    - persisted > registered → throw `ManifestRegression` (refuses to run older code against newer state).
  - Snapshots are now stamped with `runningVersion` (the version actually executing), so sticky activations preserve the persisted version stamp.
  - New host metric: nothing — covered by `migrationsApplied`.
- **`Runtime`** owns the `ClassLoader`; `Directory` wires it into every `ActorHost` along with the `outbound` callbacks for the bridge.
- **Publisher forbids top-level `import` / `export`** statements (`ForbiddenImport` error). The function-body source format doesn't support module syntax; rejecting at publish catches the bug early.
- **19 new tests** across `tests/runtime/loader.test.ts`, `tests/runtime/host-bridge.test.ts`, `tests/runtime/version-policy.test.ts`, `tests/registry/forbidden-imports.test.ts` (loader cache + sha dedup + two-version coexistence + LRU + refcount; bridge methods + cross-actor `call` round-trip; sticky / floating / ManifestRegression; import lint accepts no-imports and rejects various forms incl. cases inside line/block comments correctly).

### Added — Phase 4.1 (Publish & resolve)

- **Resolver** (`src/registry/resolver.ts`): pure async function that walks a list of root constraints over an injected `CatalogLookup`, accumulates ranges per class, picks the highest non-deprecated version satisfying every range, and re-walks deps when picks change. Throws structured `DepConflict` (with the cause path) on incompatible ranges, `ClassNotFound`, and `LimitExceeded` past 16-deep / 256-node caps.
- **Publisher** (`src/registry/publisher.ts`): validates a publish (semver version, dep ranges, `engines.actjs` compatibility, TS source parse via the `typescript` compiler API), writes through `driver.publishClass`, and emits a `class.published` audit entry. Errors: `InvalidVersion`, `InvalidDepRange`, `IncompatibleEngine`, `SyntaxInvalid`.
- **HTTP routes** in `src/v1/routes.ts` mounted on Express by `top.ts`:
  - `POST /v1/classes/:name/versions` (placeholder admin gate via `X-Actjs-Admin: 1`) — Zod-validated body, 201 on success, 409 on duplicate.
  - `GET /v1/classes/:name/versions` — lists all published versions.
  - `PATCH /v1/classes/:name/versions/:version` — set `deprecated: true` (admin).
  - `GET /v1/manifest?root=Cart@1.4.2&dep=Item@^1.0.0` — resolves a dep graph, saves the manifest via `driver.saveManifest`, returns `{sha256, resolved, constraints}`.
- `top.ts` initializes a long-lived `ValkeyPgStorageDriver` when `DATABASE_URL` (or `POSTGRES_URL`) is set and mounts the v1 routes against it. Legacy `/run` + `/upload` remain available alongside.
- **`typescript`** moves from devDependency to runtime dependency for parse-only source validation.
- **`semver`** + **`zod`** added as runtime dependencies.
- 34 new tests across `tests/registry/resolver.test.ts`, `tests/registry/publisher.test.ts`, and `tests/v1/routes.test.ts` (live Express boot with the memory driver).

### Added — Phase 3.3 (Reminders & migrations)

- **Reminders (storage layer + dispatcher).**
  - Migration `0002_reminders.up.sql` adds the `reminder` PG mirror table with a partial index on `(when_ms) WHERE delivered_at IS NULL`.
  - `ReminderMsg` gains `className` so the dispatcher can route via `runtime.tell`.
  - `ValkeyPgStorageDriver.enqueueReminder` writes the durable PG row first, then mirrors to the Valkey ZSET. `popDueReminders` uses an atomic Lua `ZRANGEBYSCORE + ZREM` and marks the matching PG rows `delivered_at = now()`. `init()` re-primes the ZSET from PG undelivered rows so a Valkey-only crash is recoverable.
  - New `ReminderDispatcher` (`src/runtime/reminder-dispatcher.ts`): 100 ms tick (configurable), batched pop, delivery via a `ReminderSink` injected by `Runtime`. Per-dispatcher metrics: `ticks`, `delivered`, `failures`.
  - `Runtime.scheduleReminder(class, id, when, type, payload)` is the new public API. Auto-starts the dispatcher on first call; stops on `runtime.shutdown()`.
- **Migrations.**
  - Optional `migrate?(prevState, prevVersion)` on `Actor<S>` and `migrateEvent?(prevEvent, prevVersion)` on `EventSourced<S, E>` (both pure — no host bridge).
  - `ActorHost` on activation detects `snap.version !== registration.version` and:
    - SWM: writes the prior snapshot to the retention slot at `seq = -1`, calls `migrate`, force-flushes the new snapshot stamped at the registered version. A class without a `migrate` function just re-stamps the version.
    - ES: each historical event's `classVersion` is compared against the running version during `replayEvents`; mismatched events are run through `migrateEvent` before `reduce`.
  - New host metric: `migrationsApplied`.
- **Runtime API.** `Runtime` constructor now accepts a `RuntimeOptions` second arg (`{ reminders?: ReminderDispatcherOptions }`); the dispatcher is reachable via `runtime.reminderDispatcher`.
- **7 new tests** across `tests/runtime/reminders.test.ts` (basic dispatch, scheduled-time gate, survive-restart, delivery-count metrics) and `tests/runtime/migrations.test.ts` (SWM migrate with retention slot, no-migrate version re-stamp, ES migrateEvent on replay).

### Added — Phase 3.2 (Event-sourced actors)

- `ActorHost` now detects `EventSourced<S, E>` subclasses and switches its commit path:
  - Handlers must return `E[]`. Empty arrays are legal read-only no-op commits (no seq bump, no log write).
  - Each non-empty return is appended atomically via `driver.appendEvents`, then folded through `reduce(state, event)`.
  - The host normalizes both `{type, payload}` records and tagged-union shapes (`{type, ...rest}`) into the wire form.
- Event-count snapshot scheduler (per-class `snapshotEveryNEvents`, default 100). Every threshold crossing fires a snapshot synchronously; an additional snapshot is force-flushed on deactivate to capture trailing events.
- Cold-start replay: on activate, the host walks `readEvents(snapshot.seq + 1n, head)` from the storage driver and folds each event in order, streaming so memory stays O(state) not O(events). If the replay distance exceeds the snapshot threshold, an opportunistic snapshot is written before opening to traffic.
- New host metrics: `eventsAppended`, `eventsReplayed`.
- 9 new tests (`tests/runtime/event-sourced.test.ts`) covering reduce equivalence, empty-event commits, throw-mid-batch atomicity, snapshot threshold, cold-start at seq M, snapshot equivalence (replay vs original fold), 10k-event long-history cold start, and multi-actor independence.

### Added — Phase 3.1 (Actor host: SWM mailbox)

- `Runtime` (`src/runtime/runtime.ts`) — public `register` / `tell` / `call` / `drain` / `shutdown` surface; owns the storage driver and the in-process actor directory.
- `Directory` (`src/runtime/directory.ts`) — single-node Map of active hosts with a `materializing` promise that dedupes concurrent first-touches.
- `ActorHost` (`src/runtime/host.ts`) — per-actor owner that runs `onInit`/`onActivate`/`onDeactivate`, dispatches one mailbox item at a time, debounces snapshot writes (250 ms trailing), and self-deactivates after 5 min idle. Per-actor metrics (`tellsHandled`, `tellsDropped`, `snapshotsWritten`, `handlerErrors`, `callsHandled`).
- `Mailbox<T>` (`src/runtime/mailbox.ts`) — bounded single-consumer queue. `MailboxFullError` for over-cap `call`s; `tell` drops with a counter increment.
- Durable inbox stream added to the storage driver: `appendInbox`, `readPendingInbox`, `ackInbox`, `pendingInboxCount`. Memory implementation backed by arrays + acked-set; valkey-pg uses plain Valkey streams (XADD / XRANGE / XDEL).
- Inbox replay on activate: a fresh `ActorHost` re-enqueues every unacked entry before opening to new traffic — guarantees a crash mid-batch converges after restart.
- Three new conformance scenarios cover the inbox.
- 24 new tests (`mailbox`, `host`, `end-to-end`) including a 10k-tell-then-process-restart e2e and a serial-invariant test that proves handlers never overlap on one actor.

### Added — Phase 2 (Storage layer)

- Postgres schema in `migrations/0001_init.up.sql` (down counterpart provided): `actor`, `actor_snapshot`, `actor_event` (RANGE-partitioned by `ts` with a default partition + current-month bootstrap), `class_version`, `class_blob`, `manifest`, `audit`.
- Tiny migration runner `src/storage/migrate.ts` with `_migrations` bookkeeping; rejects re-applies with mismatched sha256.
- `StorageDriver` interface in `src/storage/driver.ts` covering actors, snapshots, ES events, reminders, class versions + content-addressed source, manifests, idempotency, audit.
- Two driver implementations behind that interface:
  - `MemoryStorageDriver` (`src/storage/memory.ts`) — full in-memory implementation with a settable clock for tests.
  - `ValkeyPgStorageDriver` (`src/storage/valkey-pg.ts`) — production driver; PG = source of truth, Valkey caches hot snapshots + serves reminders/idempotency.
- Snapshot codec (`src/storage/codec.ts`) using `node:zlib` gzip; oversized-snapshot warning at 64 KiB.
- Valkey key conventions in `src/storage/keys.ts`.
- Shared conformance suite (`tests/storage/conformance.ts`) — 19 scenarios both drivers must satisfy identically. Runs against memory always; against valkey-pg when `ACTJS_TEST_POSTGRES_URL` is set.
- `pg` dependency + `@types/pg` dev dep.
- Ops: `ops/valkey.conf` (AOF everysec + RDB defaults), `ops/grafana/datasources.yaml` placeholder, `ops/backup.sh` script.
- CI: new `storage-conformance` job running against Postgres + Valkey service containers.

### Changed

- `docker-compose.yml` mounts `ops/valkey.conf` into the Valkey container.

### Added — Phase 1 (Domain model & types)

- New base classes:
  - `Actor<S>` in `src/actor.ts` — SWM lifecycle (`onInit`, `onActivate`, `onDeactivate`, `snapshot`).
  - `EventSourced<S, E>` in `src/event-sourced.ts` — opt-in event sourcing with `initialState` + `reduce`.
  - `Replica<S>` in `src/replica.ts` — `persistOnDeactivate = false` for derived views.
- `@handler` decorator (TC39 stage-3) + `getHandlers(ctor)` accessor in `src/handler.ts`.
- Branded primitives in `src/types/`:
  - `ActorId`, `ClassName`, `Version`, `ClassRef` with `as*` boundary helpers and `mkActorId()` / `mkClassRef()`.
  - `Manifest = ReadonlyMap<ClassName, Version>` with canonical `manifestSha256()` (sorted-key JSON).
  - `Envelope<T>` + `ActorRef` wire shapes.
- Subpath package exports: `actjs/types`, `actjs/actor`, `actjs/event-sourced`, `actjs/replica`, `actjs/handler`, `actjs/legacy`.
- `uuidv7` runtime dependency.

### Changed

- Legacy classes (`Actor`, `Aggregate`, `Replica`, `GAct`) are now reached via `import ... from 'actjs/legacy'` and re-exported under `Legacy*` names. The original `src/gact.ts` still serves `/run` + `/upload` unchanged.

### Added

- TypeScript-first toolchain: strict `tsconfig`, ESM only, `tsc -b` for builds, `tsx` for dev.
- Vitest unit test suite with v8 coverage and CI thresholds (80 / 80 / 70 / 80).
- ESLint flat config (`@typescript-eslint/recommended` + `eslint-plugin-import`) and Prettier.
- Multi-stage `Dockerfile` (distroless final stage) + `docker-compose.yml` with Valkey and Postgres.
- GitHub Actions CI: lint, typecheck, test, build, docker, and a demo.bash integration job.
- `CHANGELOG.md` (this file).

### Changed

- Source moved to `src/` and converted from `.js` to `.ts` (`error.ts`, `gact.ts`, `top.ts`, `main.ts`, `scratch.ts` — formerly `x.js`).
- `npm start` now runs `node dist/main.js`; build is required first.
- `package.json` bumped to `0.3.0` and gained `engines.node: ">=20"`.

### Removed

- Legacy `.js` engine source files (`error.js`, `gact.js`, `top.js`, `main.js`, `x.js`); their behavior is preserved by the new `src/*.ts` equivalents.

## [0.2.0] — pre-history

Earlier modernization of the original sketch: replaced Babel + bluebird-promisified redis with native async + `redis@4`, `multer@2`, Express 5, and `new AsyncFunction` for user-code execution.
