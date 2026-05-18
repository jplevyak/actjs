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

- [ ] `actor.scheduleAt(when, type, payload)` API on the `actjs`
      host bridge (the bridge itself is wired in Phase 4.2; this
      task provides the storage-level call).
- [ ] Driver-level enqueue: `enqueueReminder(when, msg)` writes the
      Valkey ZSET *and* a PG `reminder` mirror row in one logical
      transaction (PG is source of truth; Valkey is the hot queue).
- [ ] Dispatcher loop:
  - [ ] Tick every 100 ms (configurable).
  - [ ] `ZRANGEBYSCORE reminders -inf <now> LIMIT 0 N` then
        `ZREM` (use Lua to make pop atomic).
  - [ ] Deliver each as a `tell` to `(actorId, type, payload)`.
  - [ ] On delivery success, delete the PG mirror row.
- [ ] Recovery: on startup, rebuild the Valkey ZSET from PG
      `reminder` rows whose `delivered_at IS NULL`.
- [ ] Sharding hook: dispatcher key is configurable (default
      `reminders`); used by Phase 9 to shard by time bucket without
      reworking this code.

### Migrations

- [ ] On activate, if persisted `class_version` ≠ resolved version
      (per request manifest), the runtime walks the chain:
  - [ ] List all `class_version` rows for the class between
        `from` and `to`.
  - [ ] For each step, call `migrate(prev, prevVersion)` (SWM) or
        `migrateEvent(event, prevVersion)` over the event tail (ES).
  - [ ] Write a new snapshot at the target version.
  - [ ] The old snapshot is retained at `actor_snapshot(actor_id,
        -1)` (sentinel seq) for the configurable retention window.
- [ ] Migrations are required to be pure; the runtime gives them
      only `actjs.now`, `actjs.log`, and the prior snapshot/event.
      No `actjs.call` from inside a migration.
- [ ] `actctl actor migrate <id> <newVersion>` — explicit, for sticky
      actors.
- [ ] `actctl migrate dry-run --class X --from A --to B [--sample
      N]`:
  - [ ] Picks N random actors of class X currently on version A.
  - [ ] Runs the chain in memory.
  - [ ] Reports JSON diffs (snapshot before / after).
  - [ ] Does NOT write.

### Hot / warm / cold activation

- [ ] Activation path:
  - [ ] Hot: `actor:<id>:hot` HIT → deserialize → done.
  - [ ] Warm: hot MISS, PG snapshot exists → load snapshot, populate
        Valkey hot cache, done.
  - [ ] Cold (SWM): no snapshot → `onInit(args)`, new actor.
  - [ ] Cold (ES): no snapshot, no events → `initialState()`.
  - [ ] Cold-from-events (ES): no snapshot but events exist →
        `initialState() + reduce(all events)`. (Use streaming from
        3.2.)
- [ ] `actor:<id>:hot` TTL configurable (default: never; eviction is
      via idle deactivation).

### Tests

- [ ] Reminder fires across a process restart (kill -9 + reboot).
- [ ] Reminder fires once even with two dispatchers racing
      (Lua-pop ensures `ZREM` is part of the same transaction).
- [ ] SWM migration: `Cart 1.0.0 → 1.1.0` adds a `currency` field;
      activate a 1.0.0 actor under 1.1.0; verify field is present
      and the previous snapshot is in the retention slot.
- [ ] ES `migrateEvent`: replace one event type with two; replay
      under new version produces equivalent final state.
- [ ] Dry-run reports a stable diff structure that downstream
      `actctl` UI can render without server changes.
- [ ] Cold-from-events for a 100k-event actor cold-starts in bounded
      time (snapshot interval dominates).

---

## Risks & watch-outs

- [ ] Reminders are the only Valkey-only durable state. Loss = loss
      of liveness. The PG mirror is the safety net; make sure the
      reconciliation path is exercised in CI.
- [ ] `ZRANGEBYSCORE` is a sorted-set scan; under heavy load this
      can stall Valkey. Cap LIMIT and budget the dispatcher.
- [ ] Migrations that mutate the prior snapshot in place will
      eventually bite. Always return a fresh object from `migrate`.
- [ ] Dry-run reads from prod — make sure it's read-only by
      construction (no driver write path).
- [ ] Don't let cold-from-events ES boot starve other actors. The
      streaming reader yields, but ensure the host's event loop is
      not blocked.
- [ ] Old snapshots in `actor_snapshot(_, -1)` accumulate. The
      retention sweeper must exist or PG bloats. Document the
      retention window in the ADR.
