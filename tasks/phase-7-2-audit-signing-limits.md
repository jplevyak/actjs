# Phase 7.2 — Audit, signing, limits

> Source: [PLAN.md § Phase 7c/7d/7e](../PLAN.md#phase-7--production-hardening)
> Decisions: [phase-7-2-audit-signing-limits.adr.md](./phase-7-2-audit-signing-limits.adr.md)

## Goal

The three remaining production-hardening pieces: an append-only audit
log, optional Ed25519 code signing for class publishes, and per-
principal + per-actor rate / quota limits.

## Done when

- [x] Every privileged action (publish, deprecate, admin RPC,
      tombstone, capability mint, signing-key changes, snapshot
      migration) appears in `audit` with the right principal +
      target.
- [x] With `requireSignedClasses: true`, an unsigned publish is
      rejected; a signature from a non-registered or revoked kid is
      rejected; a valid signature is accepted.
- [x] A principal exceeding their rate budget gets 429 with
      `Retry-After`.
- [x] Per-actor mailbox cap (3.1) and per-class active-actor cap
      fire with structured errors.

---

## Checklist

### Audit log

- [x] `appendAudit(entry)` driver method (already declared in 2c).
- [x] Every privileged action calls it. Audit emits include:
  - [x] `class.published`, `class.deprecated`, `class.signed`.
  - [x] `actor.tombstoned`, `actor.migrated`.
  - [x] `signing-key.added`, `signing-key.revoked`.
  - [x] `capability.minted`. _(Revoke comes through the Blocklist
        APIs in 7.1; an explicit audit emit lands when the
        admin/revoke route is added in 7.2b.)_
  - [x] `admin.rpc` for `/v1/run`.
- [x] Each entry: `{ id, ts, principal, action, target, meta }`.
- [ ] Optional S3 mirror (append-only, object-lock); config flag.
      _(Deferred to 7.2b; see ADR.)_
- [ ] `actctl audit follow [--principal=] [--action=]` tails the
      log. _(Deferred to 7.2b; the audit query API isn't exposed
      yet.)_

### Code signing (optional)

- [x] `signing_key` table in PG: `kid`, `algorithm`, `public_key`,
      `added_at`, `revoked_at`. _(Migration shipped;
      `MemorySigningKeyRegistry` is the v1 implementation. A
      PG-backed adapter lands in 7.2b.)_
- [x] Publish accepts:
  - [x] `signature` (base64) over `sha256:<hex>|<name>@<version>`.
  - [x] `kid` (signing key id).
- [x] Verification:
  - [x] Look up `kid` in the registry; refuse if revoked.
  - [x] Verify Ed25519 signature.
  - [x] Record `signed_by` on the `class_version` row.
- [x] Config: `requireSignedClasses: boolean` (default false).
- [x] `actctl key add <pub.pem> --kid=...`,
      `actctl key revoke <kid>`,
      `actctl publish --sign <priv.pem>`.

### Rate limits & quotas

- [x] Per-principal token bucket on `actor.call`:
  - [x] Capacity + refill from config (per role; default unset).
  - [x] Implementation: in-process token bucket; ADR locks the
        per-node v1.
  - [x] 429 with `Retry-After` header.
- [x] Per-class active-actor cap:
  - [x] Tracked in the in-process directory; new `create` /
        activation rejected when over.
  - [x] Returns 503 `CapacityExhausted`.
- [x] Per-actor mailbox cap (3.1) confirmed wired and exposed via
      `host.metrics.tellsDropped`.

### Cross-cutting

- [x] Rate / capacity errors carry structured fields so Phase 8
      dashboards can alert on them (`subject`, `operation`,
      `retryAfterSeconds`, `class`, `cap`).

### Tests

- [x] Audit: every emit lands within a synchronous assertion via
      `MemoryStorageDriver.auditEntries()`.
- [x] Signing happy path + each rejection mode (no sig + required,
      unknown kid, revoked kid).
- [x] Rate limit: burst over capacity → 429; refill → succeed.
- [x] Active-actor cap: create up to limit → 503 thereafter.

### Documentation

- [x] `docs/ops-hardening.md` operator-facing runbook.
- [x] ADR locks the trade-off decisions.

---

## Risks & watch-outs

- [x] Audit must never silently fail. _(Strict default; opt-in
      best-effort.)_
- [x] Signing keys leak. _(Mitigate via `kid` rotation; audit each
      add and revoke; document the rotation procedure in
      `docs/ops-hardening.md`.)_
- [x] Token-bucket Lua scripts can be wrong in subtle ways. _(N/A
      in v1: in-process bucket only. Lua arrives with the Valkey-
      backed implementation in Phase 9.)_
- [x] Per-class active-actor caps are easy to set too low and cause
      a denial of service. _(Default is unset / unlimited; ADR.)_
- [x] S3 audit mirror writes are slow and not transactional with
      PG. _(Deferred; will arrive with the async queue.)_
