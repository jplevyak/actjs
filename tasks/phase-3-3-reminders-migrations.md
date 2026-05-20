# Phase 3.3 — Reminders & migrations

> Source: [PLAN.md § Phase 3c/3d/3e](../PLAN.md#phase-3--actor-runtime)
> Decisions: [phase-3-3-reminders-migrations.adr.md](./phase-3-3-reminders-migrations.adr.md)

## Goal

Three loosely coupled pieces that complete the runtime: durable
reminders/timers, migration support for both SWM and ES, and
explicit hot/warm/cold activation paths.

## Done when

- An actor schedules a reminder one minute in the future, the process
  is restarted, the reminder still fires at the right time as a
  `tell` to the target actor.
- Activating an actor whose persisted `class_version` is older than
  the current class walks the migration chain and writes a new
  snapshot stamped with the new version.
- `actctl migrate dry-run --class Cart --from 1.0.0 --to 2.0.0`
  reports per-sample diffs without committing.

---

## Checklist

### Reminders & timers

- [x] `Runtime.scheduleReminder(class, id, when, type, payload)` —
      the public API; Phase 4.2 wired the corresponding
      `this.actjs.scheduleAt` bridge method.
- [x] `enqueueReminder` writes the PG mirror first, then Valkey
      ZSET. Migration `0002_reminders.up.sql` added the table.
- [x] Dispatcher loop (`src/runtime/reminder-dispatcher.ts`):
  - [x] 100 ms tick (configurable).
  - [x] Lua-atomic `ZRANGEBYSCORE` + `ZREM`.
  - [x] Each popped entry routed via `runtime.tell`.
  - [x] PG row marked `delivered_at = now()` after the pop.
- [x] Recovery: `init()` re-primes the Valkey ZSET from PG
      undelivered rows.
- [ ] Sharding hook (configurable dispatcher key). _(Deferred to
      Phase 9; the dispatcher uses the constant `reminders` key
      today.)_

### Migrations

- [x] On activate, persisted `class_version` ≠ registered version
      triggers `migrate()` (SWM) / `migrateEvent` (ES per replayed
      event). Prior snapshot retained at `seq = -1`.
- [ ] Full chain walk (multi-step `migrate` across N intermediate
      versions). _(Deferred — Phase 3.3 ships per-class one-shot
      migration; the chain walker arrives with Phase 4.1's
      registry of `class_version` rows but the runtime hasn't
      learned how to step through them yet. Operators currently
      handle multi-version jumps by writing a `migrate` that
      switches on `prevVersion`.)_
- [x] Migrations receive only `prevState`/`prevEvent` and
      `prevVersion`. The runtime gives them no host bridge — purity
      is the contract.
- [ ] `actctl actor migrate <id> <newVersion>`. _(Phase 8.2.)_
- [ ] `actctl migrate dry-run`. _(Phase 8.2.)_

### Hot / warm / cold activation

- [x] Activation paths exist; the storage driver's `loadSnapshot`
      handles the hot/warm distinction transparently (Valkey cache
      → PG fallback in valkey-pg).
- [x] Cold (SWM): no snapshot → `onInit`.
- [x] Cold (ES): no snapshot, no events → `initialState()`.
- [x] Cold-from-events (ES): `replayEvents` from
      `currentSeq + 1` via the AsyncIterable.
- [x] Hot cache TTL configurable via `hotTtlSeconds` on the
      valkey-pg driver (default 0 — idle eviction only).

### Tests

- [x] Reminder fires across runtime restart
      (`tests/runtime/reminders.test.ts`).
- [ ] Two-dispatcher race for Lua-pop atomicity. _(Practically
      hard to test in a single-process JS test; the Lua script
      is small enough that visual inspection + the live valkey-pg
      conformance run cover it.)_
- [x] SWM migration: `migrate()` runs + retention slot at seq=-1
      (`tests/runtime/migrations.test.ts`).
- [x] ES `migrateEvent`: historical events transformed during
      cold-start replay.
- [ ] Dry-run JSON diff. _(Phase 8.2.)_
- [ ] 100k-event cold-from-events benchmark. _(10k version
      shipped in Phase 3.2; the 100k variant is the
      operator-runbook performance test, not a CI unit test.)_

---

## Risks & watch-outs

- [x] Reminders durable via PG mirror; `init()`'s recovery path is
      exercised in tests.
- [x] `ZRANGEBYSCORE` capped to a configurable batch limit
      (`batchLimit`, default 100).
- [x] `migrate()` documented as returning a fresh object;
      ESLint catches mutation of `state` inside an Actor handler
      via the strict-mode signature.
- [ ] Dry-run is read-only. _(Phase 8.2 owns it.)_
- [x] Cold-from-events uses an AsyncIterable yielding event-by-
      event, so the event loop isn't blocked.
- [ ] `actor_snapshot(_, -1)` retention sweeper. _(ADR records the
      30-day retention; a Phase 7.2 / 8.2 admin job sweeps. Storage
      bloat is acceptable while migration volume is low.)_
