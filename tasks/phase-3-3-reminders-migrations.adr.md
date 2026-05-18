# ADR — Phase 3.3: Reminders & migrations

> Task: [phase-3-3-reminders-migrations.md](./phase-3-3-reminders-migrations.md)
> Plan reference: [PLAN.md § Phase 3c/3d/3e](../PLAN.md#phase-3--actor-runtime)

- **Status:** Accepted
- **Date:** 2026-05-18
- **Decider(s):** project author

## Context

Phase 3.3 closes Phase 3: durable reminders/timers, migration
hooks for both SWM and ES, and explicit hot/warm/cold activation
paths. The runtime built in 3.1 + 3.2 doesn't yet have a way to
schedule deferred work, doesn't know how to react to a version
change between snapshots and a freshly-registered class, and
doesn't surface the activation-path the host took.

Constraints carried in:

- The PG `reminder` table is new in this phase; Phase 2's schema
  intentionally left it for 3.3.
- The user-facing `actjs.scheduleAt(...)` host bridge lands in
  Phase 4.2 with the rest of the bridge; 3.3 provides the
  storage-level call and a `Runtime.scheduleReminder` proxy.
- The migration chain story is per-class today; Phase 4 introduces
  the registry-driven multi-step chain.

## Decision

### Dispatcher tick — **100 ms**

The reminder dispatcher polls every 100 ms. Resolution is
sufficient for any human-scale workflow; sub-100ms reminders are
better expressed as `setImmediate` inside a handler. The interval
is configurable per Runtime (`reminderTickMs`).

### Reminder atomicity — **PG INSERT then Valkey ZADD**

Write the durable row first, then mirror to Valkey's sorted set.
If PG succeeds and Valkey fails, the next valkey-pg `init()`
rebuilds the ZSET from undelivered PG rows. We never have a
reminder that's in Valkey but not in PG.

### Pop atomicity — **Lua script in valkey-pg**

`ZRANGEBYSCORE` + `ZREM` in one EVAL so two racing dispatchers
don't deliver the same reminder twice. Memory driver's pop is
already serial within the process.

After the Valkey pop the dispatcher marks the matching PG rows
`delivered_at = now()`. If the dispatcher crashes between the
pop and the PG update, the reminder is lost at-most-once (the
ZSET entry is gone but PG marks it undelivered) — recoverable
on next `init()` by ZADD-ing back; we accept a small
duplicate-delivery window over silent loss.

### Pre-migrate snapshot retention — **30 days**

After a migrate succeeds, the prior state is written to
`actor_snapshot(actor_id, -1)` and survives for 30 days. The
memory driver uses the same sentinel seq. A `compactExpiredPremigrate`
admin job (Phase 7.2 / Phase 8.2) sweeps; the storage write itself
is the responsibility of the host on activation.

### Migration purity — **enforced by withheld host APIs**

Migrations receive only the prior snapshot / event and the prior
version string. No `actjs.now`, no `actjs.call`, no `actjs.log`
(yet). Documented contract. Phase 4.2's host bridge will route
through a thin "migration context" that only exposes pure helpers
(deep clone, etc.) if needed.

### Hot cache TTL — **idle eviction only, no explicit TTL**

The actor's idle deactivation already evicts the hot cache when
the host shuts down (the host's `__resetForTests` and `evict`
paths both delete the `actor:<id>:hot` key). A separate TTL would
race with the idle timer and complicate snapshot freshness.
Operators who really want a hard TTL set `hotTtlSeconds` on the
valkey-pg driver options (Phase 2).

## Consequences

### Positive

- Reminders survive a Valkey-only crash (PG mirror); they survive
  a PG-only crash because Valkey holds the live ZSET. Both halves
  going down simultaneously is the only loss scenario, and that
  scenario also breaks every other actor write.
- Migration runs on every cold activation when the persisted
  version differs from the registered one — operators don't need
  to schedule a separate "migrate everything" pass.
- Pre-migrate retention means a bad migrate is recoverable: copy
  the seq=-1 snapshot back to seq=0 (or the head event seq for
  ES) and the actor reverts.

### Negative / trade-offs

- Two storage round-trips per reminder enqueue (PG + Valkey).
  Acceptable; reminder enqueue is rarely a hot path.
- Per-class migration (vs registry chain) means migrating across
  multiple versions in one shot requires the user's `migrate`
  function to handle every prior version. Phase 4 makes this
  cleaner with the chain.
- The dispatcher polling overhead is ~10 RPS to the storage layer
  even when idle. Negligible against any real workload.
- 30-day retention bloats `actor_snapshot` proportionally to
  migration frequency. Operators who migrate aggressively will
  want to tune `actor_snapshot_retention_days`.

### Follow-ups for later phases

- Phase 4.1 publish-validator enforces a chain of versions; the
  walker here grows from "registered vs persisted" to "walk every
  version in `class_version` between persisted and target."
- Phase 4.2's `actjs` host bridge wires `actjs.scheduleAt(...)`
  into `Runtime.scheduleReminder`.
- Phase 7.2 admin: `actctl actor migrate <id> <version>` for
  explicit sticky-actor migration; `actctl migrate dry-run`.
- Phase 8.1 metric: `reminder_dispatch_lag_seconds` (now - when
  at delivery).
- Phase 9 cluster: dispatcher key sharded by time bucket so
  multiple nodes can drain `reminders:<minute>` in parallel.

## Alternatives considered (and why not)

- **Reminders durable in Valkey only.** Simpler, but AOF
  `everysec` plus a host crash gives a 1s window of lost
  reminders. The PG mirror closes it for negligible cost.
- **Reminders in a queue service (NATS, RabbitMQ, …).** Adds
  operational weight orthogonal to the rest of actjs. PG +
  Valkey are already required; piggyback.
- **Synchronous migration on publish.** Phase 4 will add the
  chain; in 3.3 a registered class supersedes whatever the
  snapshot says. Right place to handle is on activation, not
  publish.
- **No retention slot.** A bad migrate is unrecoverable. Cheap
  insurance.

## References

- PLAN.md § Phase 3c/3d/3e
- tasks/phase-3-3-reminders-migrations.md
- Phase 2 conformance: reminder scenarios.
