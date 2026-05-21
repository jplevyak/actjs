# ADR — Phase 7.2: Audit, signing, limits

> Task: [phase-7-2-audit-signing-limits.md](./phase-7-2-audit-signing-limits.md)
> Plan reference: [PLAN.md § Phase 7c/7d/7e](../PLAN.md#phase-7--production-hardening)

- **Status:** Accepted
- **Date:** 2026-05-20
- **Decider(s):** John Plevyak

## Context

Three independent operational concerns: an append-only audit log,
publish-time code signing, and rate / capacity limits. They share a
phase because each piece is small and they're all what an operator
needs before pointing real traffic at the server.

Phase 7.1 already wired the Auditor's underlying `appendAudit`
driver method; this phase plugs it into every privileged action and
ships the signing + limits subsystems alongside.

## Decisions

### Audit write transactional with action — **strict by default, best-effort opt-in**

Strict is the default `Auditor` mode. The `driver.appendAudit`
write is awaited before the route returns; a failure throws
`AuditWriteError` and the action propagates the error. A
best-effort mode is available (`auditOptions: { mode: 'best-effort' }`)
for deployments where availability outranks completeness.

**Rationale:** auditability is the entire point. Operators who don't
care can flip the switch; operators who do care get the strict
default without thinking.

### S3 mirror — **deferred to 7.2b**

The PG-backed driver writes synchronously to the `audit` table; the
S3 mirror (object-lock retention) is a separate concern that needs
async-queue plumbing not yet in place. The schema is
forward-compatible: rows are immutable and the queue can replay
from the table.

### Signing default — **optional, default-off**

`requireSignedClasses` defaults to `false`. Enabling it is a
deliberate operator step. With the flag on, an unsigned publish
returns `400 SignatureRequired`; a bad signature returns `400
SignatureInvalid`.

**Rationale:** the surrounding developer ergonomics (local dev,
integration tests, CI without secrets) all need unsigned publishes
to work. Production deployments flip the switch via config.

### Token-bucket implementation — **in-process per-node**

Each node enforces its share of the budget. Buckets live in
`Map<subject, BucketState>`; refill is recomputed lazily on each
`try`. Idle eviction trims after 10 minutes.

**Rationale:** zero dependencies, deterministic for tests, and
correct on a single node — which is the only deployment topology
v1 supports. Phase 9 swaps in a Valkey-backed shared counter; the
`RateLimiter.enforce(principal)` call site stays the same.

### Per-class active cap default — **unset (0 = unlimited)**

`activeActorCapPerClass: 0` means unlimited. Operators opt in by
setting a number; the cap exists so a runaway code path that mints
actors without bound can be braked.

**Rationale:** any default we pick is wrong for someone. Unset is
explicit, and a `503 CapacityExhausted` body always reports the
configured cap so the failure is self-describing.

### Signing-key storage — **memory in v1, PG in 7.2b**

`MemorySigningKeyRegistry` is the only implementation shipping this
phase. The `signing_key` migration (`0003_signing_keys.up.sql`) is
included so the production schema is ready; the PG-backed adapter
lands when the PG storage driver test harness can run in CI.

The interface (`SigningKeyRegistry`) is stable: swap-in is a
constructor change at `buildApp`.

### Capability audit — **best-effort, side-channel**

`actjs.mintCapability(...)` in a handler logs a `capability.minted`
audit row asynchronously (fire-and-forget with a warn log on
failure). The mint itself never fails for an audit error — losing
an audit row is preferable to losing a request that already had
its work done.

**Rationale:** capability mints sit on the request hot path; a
strict audit write would inflate p99 latency. The fire-and-forget
log is acceptable because capabilities are themselves revocable.

## Consequences

### Positive

- Every privileged action is auditable by default; the strict
  default means an operational miss is loud, not silent.
- Signing is opt-in and verifiable end-to-end via `actctl publish
--sign` + `actctl key add`.
- Clients see well-formed 429 + `Retry-After` for rate limits and
  503 `CapacityExhausted` for cap breaches.
- The `RateLimiter.enforce` and `Directory.checkActiveCap` call
  sites are stable; cross-node swaps in Phase 9 don't touch any
  caller.

### Negative / trade-offs

- The in-process limiter under-counts when a principal hits
  multiple nodes; each node has its own budget. Operators are
  warned in `docs/ops-hardening.md`.
- Audit writes on the publish path serialize the publish behind the
  driver round-trip. Acceptable because publishes are rare; reads
  and calls are unaffected.
- Best-effort capability audit means a transient driver failure
  drops the `capability.minted` row. Capabilities have a `jti` we
  can correlate against the blocklist if revocation is needed
  later.

### Follow-ups for later phases

- 7.2b: PG-backed `MemorySigningKeyRegistry` adapter, PG-backed
  `Blocklist`, S3 audit mirror.
- 8.1: dashboards for `audit.*`, `rate_limit.denials`,
  `capacity.exhausted`.
- 9: Valkey-backed shared rate limiter + active-actor counter.

## Alternatives considered (and why not)

- **Lua script in Valkey for the token bucket.** Defers a real
  multi-node implementation but introduces a dependency for the
  single-node case where in-process is correct. The interface is
  stable, so we'll land Lua when we need it.
- **Required signing as the default.** Friction-heavy; would break
  every existing test and demo. Operator opt-in is the right
  default for v1.
- **One audit write per action wrapped in a PG transaction with
  the action itself.** Tempting for strict atomicity but couples
  the audit table to the action's own write paths (which span
  multiple tables for ES actors). Strict-mode propagation gives
  the same observable guarantee with less coupling.

## References

- `src/audit/` — `Auditor`, `AUDIT_ACTIONS`, `AuditWriteError`.
- `src/limits/` — `TokenBucket`, `RateLimiter`,
  `CapacityExhaustedError`.
- `src/registry/signing.ts` — `MemorySigningKeyRegistry`.
- `docs/ops-hardening.md` — operator runbook + CLI examples.
- `migrations/0003_signing_keys.up.sql` — PG schema for the
  signing-key registry.
