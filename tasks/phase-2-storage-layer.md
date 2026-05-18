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

- [ ] Migration tooling chosen and wired up (`node-pg-migrate`,
      `drizzle-kit`, `kysely`, or hand-rolled `.sql` files — see ADR).
- [ ] Migration 0001 creates the schema from PLAN.md Phase 2a:
  - [ ] `actor` table + `actor_tags_gin` + `actor_class_idx`.
  - [ ] `actor_snapshot` (PK on `(actor_id, seq)`).
  - [ ] `actor_event` partitioned by `RANGE (ts)`; default partition
        plus one monthly partition initialized.
  - [ ] `class_version` + `class_version_active` partial index.
  - [ ] `class_blob`.
  - [ ] `manifest`.
  - [ ] `audit`.
- [ ] Down-migration that drops all of the above cleanly.
- [ ] CI runs the up + down + up sequence on a fresh PG instance.

### Valkey layout

- [ ] Key-naming module that produces the keys in PLAN.md Phase 2b
      (`actor:<id>:hot`, `actor:<id>:inbox`, `reminders`,
      `manifest:<sha>`, `idem:<key>`, `class:<name>:meta`,
      `class:<name>:v:<ver>`, `blob:<sha>`).
- [ ] Encoder/decoder for the snapshot blob (`zstd` compress +
      base64 only if needed for transport; raw bytes preferred).
- [ ] AOF + RDB defaults documented in `ops/valkey.conf`.

### StorageDriver interface

- [ ] `src/storage/driver.ts` — interface as sketched in PLAN.md
      Phase 2c, plus:
  - [ ] `getClassSource(name, version): Promise<Buffer | null>`
  - [ ] `listClassVersions(name): Promise<ClassVersion[]>`
  - [ ] `loadManifest(sha): Promise<Manifest | null>`
  - [ ] `saveManifest(sha, resolved): Promise<void>`
  - [ ] `loadIdempotency(key): Promise<unknown | null>`
  - [ ] `saveIdempotency(key, response, ttlMs): Promise<void>`
  - [ ] `appendAudit(entry): Promise<void>`
- [ ] `src/storage/valkey-pg.ts` — production driver. PG = source of
      truth for snapshots, events, classes, audit. Valkey = hot cache
      for snapshots, inbox stream, reminders, manifest cache, idem.
- [ ] `src/storage/memory.ts` — in-memory driver used by unit tests.
      Lives behind the same interface so tests don't need PG/Valkey.

### Tests

- [ ] Schema round-trip: write each row type, read it back, assert
      shape.
- [ ] Partition-pruning sanity: events queried by `actor_id` and a
      time range don't scan all partitions.
- [ ] Stream durability: write to `actor:<id>:inbox`, restart Valkey
      with AOF on, read remaining entries.
- [ ] Conformance suite: a shared test harness runs the same call
      sequence against `valkey-pg` and `memory` drivers and asserts
      identical observable behavior.
- [ ] Property test: random sequences of `save/load/append/read`
      preserve invariants (no event with `seq <= snapshot.seq`,
      monotonic seq per actor, etc.).

### Operational scaffolding

- [ ] `ops/grafana/datasources.yaml` declares PG + Valkey scrape
      targets (dashboards land in Phase 8).
- [ ] Backup script: `pg_dump` + Valkey `BGSAVE` + an upload hook
      (target left as `s3://...` placeholder for the deployer).
- [ ] Connection pooling chosen (`pg-pool` defaults vs PgBouncer
      sidecar — see ADR).

---

## Risks & watch-outs

- [ ] Snapshots > a few MB will choke PG `bytea`. The plan defers
      S3 to "if needed"; record a size threshold the driver enforces
      so this is detectable, not surprising.
- [ ] Don't let `appendEvents` swallow partial failures. Use one PG
      transaction per turn; assert seq monotonicity inside the
      transaction.
- [ ] Postgres `actor_event` partitioning needs a partition-create
      job. Add it now (cron in compose, scheduled in production)
      rather than discovering it when a partition fills.
- [ ] AOF + RDB tuning is a footgun — defaults are sometimes too
      lossy. The ADR must commit to a durability target.
- [ ] The in-memory driver must NOT silently diverge over time —
      conformance tests are the only thing keeping it honest.
