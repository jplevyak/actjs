# ADR — Phase 2: Storage layer

> Task: [phase-2-storage-layer.md](./phase-2-storage-layer.md)
> Plan reference: [PLAN.md § Phase 2](../PLAN.md#phase-2--storage-layer)

- **Status:** Accepted
- **Date:** 2026-05-18
- **Decider(s):** project author

## Context

Every later phase reads and writes through this layer. The locked
PLAN.md choices are Valkey + Postgres (PG = source of truth), no
S3 in v1, and an in-memory driver behind the same interface for
unit tests. This ADR fills in the lower-level tooling decisions
those defaults leave open.

## Decision

### Migration tooling — **raw `.sql` files + a small Node runner**

Migrations live in `migrations/NNNN_<name>.up.sql` /
`.down.sql`. A 50-line runner (`src/storage/migrate.ts`) walks the
directory, tracks applied entries in a `_migrations` table, and
applies pending files in dependency order within one transaction
each.

Reasons:

- Operators who run their own Postgres prefer raw SQL they can
  inspect and run with their own tooling.
- Zero migration-library dependency. No surprise breakages on
  upgrade.
- The full PG dialect is available (partitioning, GIN, partial
  indexes) without escaping a query-builder DSL.
- `node-pg-migrate` and `drizzle-kit` give us nothing the runner
  doesn't, at the cost of a moving-part we'd have to upgrade.

### Postgres access library — **`pg` (node-postgres) + built-in `pg.Pool`**

The boring industry default. Most documentation, most operator
familiarity, smallest surprise budget. We use `pg.Pool` directly;
no PgBouncer sidecar in v1 — the Phase 9 cluster work re-examines.

`postgres` (porsager/postgres) is also good but less universally
known; `kysely` solves a different problem (query building, not
just connectivity).

### Valkey client — **`redis@4` (existing)**

Already a dependency. Wire protocol is RESP, identical between
Redis and Valkey. The few Valkey-specific commands we'd want
(none in v1) can be invoked via raw `sendCommand` if needed.
Migrating to `iovalkey` is a future swap; the storage-driver
interface insulates the rest of the system from the choice.

### Durability — **AOF `everysec` + RDB every 1 h**

Documented in `ops/valkey.conf`. `everysec` is the standard
durability/throughput tradeoff: at most one second of writes are
lost on a hard crash. RDB hourly gives us a fast cold-restart
artifact. `always` is too slow for the inbox stream's write path.

### Snapshot blob threshold — **64 KiB**

Above this, the driver records a warning metric. We don't reject
yet (no S3 fallback in v1); the warning surfaces the moment a
class needs the Phase 6 work to land an S3 path.

### Snapshot compression — **gzip via `node:zlib`**

Built-in, no native dep, fine compression ratio for actor JSON.
`zstd` would be 10–20% better but requires Node 22 (or a native
addon); not worth pulling in for v1. The codec module is a 30-line
swap-out site once we move to Node 22.

## Consequences

### Positive

- Migration story is approachable for any operator who can read
  SQL.
- Zero new heavy dependencies. `pg` is the only addition.
- The storage-driver interface lets us swap Valkey-client and
  PG-client implementations without touching the rest of the
  system.

### Negative / trade-offs

- Raw SQL means we can't auto-generate types from the schema.
  Phase 1's branded primitive types are the only typing layer at
  the row level. Worth it for the simplicity of `.sql` files.
- gzip is ~10–20% larger than zstd at typical settings. Acceptable
  in exchange for zero native deps.
- `pg.Pool` defaults will not survive a 10x traffic spike without
  tuning. Operators set their own `max` / `idleTimeoutMillis`.
- Skipping PgBouncer means the actjs process count == PG connection
  count × pool size. Becomes a constraint in Phase 9; design hooks
  preserved.

### Follow-ups for later phases

- Phase 3 (3.1 / 3.2) writes through this layer; if snapshot writes
  become a hot path, revisit Phase 2's "no S3" rule.
- Phase 6 may want to upgrade to Node 22 to use built-in `zstd`.
- Phase 9 cluster work decides whether to keep `pg.Pool` direct or
  put PgBouncer in front.

## Alternatives considered (and why not)

- **`node-pg-migrate`.** Adds a dependency for nothing the 50-line
  runner doesn't already do. Templates obscure raw SQL.
- **Drizzle.** ORM + migrations + query builder. Too much for a
  storage layer that wants to expose plain SQL semantics.
- **Kysely.** Excellent for query building, irrelevant for raw
  schema migrations.
- **`postgres` (porsager/postgres).** Fine alternative; if we
  switch later, the storage driver isolates the rest of the code.
- **`iovalkey`.** Could move to it once it's mature; the gain over
  `redis@4` is small today.
- **AOF `always`.** Excellent durability, costs ~10x on write
  throughput. Inbox streams are hot enough this matters.

## References

- PLAN.md § Phase 2
- tasks/phase-2-storage-layer.md
- `node-postgres` docs: <https://node-postgres.com>
- Valkey persistence: <https://valkey.io/topics/persistence/>
