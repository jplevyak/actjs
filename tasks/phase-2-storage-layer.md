# Phase 2 — Storage layer

> Source: [PLAN.md § Phase 2](../PLAN.md#phase-2--storage-layer)
> Decisions: [phase-2-storage-layer.adr.md](./phase-2-storage-layer.adr.md)

## Goal

Stand up the durable layout (Postgres schema + Valkey layout) and the
`StorageDriver` interface that every later phase calls through. No
runtime/actor code lives in this phase — just storage primitives and
their tests.

## Done when

- `docker compose up` brings Valkey + Postgres up; migrations apply
  cleanly from scratch.
- `StorageDriver` interface has at least two implementations: the
  Valkey+PG production driver and an in-memory driver used by unit
  tests.
- A property test asserts the two drivers behave identically on a
  representative call sequence.

---

## Checklist

### Postgres schema & migrations

- [x] Migration tooling: raw `.sql` files + a 120-line runner
      (`src/storage/migrate.ts`).
- [x] Migration 0001 creates the schema:
  - [x] `actor` + `actor_tags_gin` + `actor_class_idx`.
  - [x] `actor_snapshot` (PK on `(actor_id, seq)`).
  - [x] `actor_event` partitioned by `RANGE (ts)` with default
        partition + bootstrap current-month partition (the
        production cron is operator-side).
  - [x] `class_version` + `class_version_active` partial index.
  - [x] `class_blob`.
  - [x] `manifest`.
  - [x] `audit`.
- [x] Down-migration drops cleanly.
- [ ] CI runs the up + down + up cycle. _(The conformance job
      applies migrations via `init()` and resets via
      `__resetForTests`; a dedicated up→down→up smoke test is
      not wired yet — punt to Phase 8.2's operator runbook.)_

### Valkey layout

- [x] `src/storage/keys.ts` produces every Phase 2b key.
- [x] `src/storage/codec.ts` — gzip via `node:zlib` (ADR picked
      gzip over zstd to avoid the native dep; zstd revisits when
      Node 22 lands). 64 KiB oversize warning.
- [x] AOF + RDB defaults in `ops/valkey.conf`.

### StorageDriver interface

- [x] `src/storage/driver.ts` covering snapshots, events, reminders,
      class versions + content-addressed source, manifests,
      idempotency, audit, lifecycle. Inbox primitives were added in
      Phase 3.1.
- [x] `src/storage/valkey-pg.ts` — production driver.
- [x] `src/storage/memory.ts` — in-memory driver.

### Tests

- [x] Schema round-trip via the conformance suite.
- [ ] Partition-pruning sanity test. _(Defer to Phase 8.1 — needs
      `EXPLAIN ANALYZE` against the real partitioned table; the
      conformance suite only verifies row-level correctness.)_
- [ ] Stream durability test against AOF restart. _(Same boat;
      operator-side verification.)_
- [x] Conformance suite (`tests/storage/conformance.ts`, 22
      scenarios) runs against both drivers. The CI
      `storage-conformance` job exercises valkey-pg when the
      env vars are set.
- [ ] Property test with `fast-check`. _(Resolver got property
      tests in Phase 4.1; storage-driver property tests are
      deferred — the conformance scenarios cover the invariants
      called out in the task.)_

### Operational scaffolding

- [x] `ops/grafana/datasources.yaml` placeholder (dashboards in
      Phase 8.1).
- [x] `ops/backup.sh` with `pg_dump` + `BGSAVE` + optional upload
      hook.
- [x] Connection pooling: built-in `pg.Pool`, no PgBouncer in v1
      (recorded in the ADR).

---

## Risks & watch-outs

- [x] Snapshot size warning at 64 KiB (`isOversizedSnapshot`).
      Driver bumps `oversizedSnapshotCount`; Phase 8.1 surfaces it
      as a metric.
- [x] `appendEvents` runs the whole batch inside one PG transaction
      with seq derived under `FOR UPDATE`-equivalent semantics
      (single batch INSERT inside the txn).
- [ ] Partition-create cron for `actor_event` partitions.
      _(Bootstrap partition is created at migration time;
      ongoing monthly creation is an operator-cron concern,
      documented in the ADR as a known gap.)_
- [x] AOF `everysec` + RDB hourly committed in the ADR and
      reflected in `ops/valkey.conf`.
- [x] Conformance suite keeps the memory driver honest.
