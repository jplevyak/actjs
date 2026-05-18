# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
