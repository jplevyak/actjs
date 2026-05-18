# ADR — Phase 2: Storage layer

> Task: [phase-2-storage-layer.md](./phase-2-storage-layer.md)
> Plan reference: [PLAN.md § Phase 2](../PLAN.md#phase-2--storage-layer)

- **Status:** Proposed
- **Date:** _TBD_
- **Decider(s):** _TBD_

## Context

_Why now: every later phase reads/writes through this layer. Locked
choices from PLAN: Valkey + Postgres, PG is source of truth, no
S3 in v1, in-memory driver required for tests._

## Decision

Likely decisions to settle here:

### Migration tooling

- Options: `node-pg-migrate`, `drizzle-kit`, raw `.sql` files,
  `kysely` migrator.
- Choice: _TBD_

### Postgres access library

- Options: `pg`, `postgres` (`porsager/postgres`), `kysely`, ORM.
- Choice: _TBD_

### Valkey client

- Options: `redis@4` (already in tree), `iovalkey`, `ioredis`.
- Choice: _TBD_

### Connection pooling

- Options: in-process `pg-pool` only, PgBouncer sidecar.
- Choice: _TBD_

### Durability target (AOF / RDB)

- Options: AOF `everysec`, AOF `always`, RDB-only, both.
- Choice: _TBD_

### Snapshot blob size threshold

- Options: 64 KiB, 256 KiB, 1 MiB.
- Choice: _TBD_

## Consequences

### Positive
- _TBD_

### Negative / trade-offs
- _TBD_

### Follow-ups for later phases
- _TBD_

## Alternatives considered (and why not)

- _TBD_

## References

- _TBD_
