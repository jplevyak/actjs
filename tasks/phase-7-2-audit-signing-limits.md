# Phase 7.2 — Audit, signing, limits

> Source: [PLAN.md § Phase 7c/7d/7e](../PLAN.md#phase-7--production-hardening)
> Decisions: [phase-7-2-audit-signing-limits.adr.md](./phase-7-2-audit-signing-limits.adr.md)

## Goal

The three remaining production-hardening pieces: an append-only audit
log, optional Ed25519 code signing for class publishes, and per-
principal + per-actor rate / quota limits.

## Done when

- Every privileged action (publish, deprecate, policy change, admin
  RPC, tombstone) appears in `audit` within 1 s with the right
  principal and target.
- With `requireSignedClasses: true`, an unsigned publish is rejected;
  a signature from a non-allowed key is rejected; a valid signature
  is accepted.
- A principal exceeding their rate budget gets 429 with `Retry-After`.
- Per-actor mailbox cap (3.1) and per-class active-actor cap fire
  with structured errors.

---

## Checklist

### Audit log

- [ ] `appendAudit(entry)` driver method (already declared in 2c).
- [ ] Every privileged action calls it. Audit emits include:
  - [ ] `class.published`, `class.deprecated`, `class.signed`.
  - [ ] `actor.tombstoned`, `actor.migrated`.
  - [ ] `policy.changed`, `signing-key.added`, `signing-key.revoked`.
  - [ ] `capability.minted`, `capability.revoked`.
  - [ ] `admin.rpc` for `/v1/run`.
- [ ] Each entry: `{ id, ts, principal, action, target, meta }`.
- [ ] Optional S3 mirror (append-only, object-lock); config flag.
- [ ] `actctl audit follow [--principal=] [--action=]` tails the log.

### Code signing (optional)

- [ ] `signing_key` table in PG: `kid`, `algorithm`, `public_key`,
      `added_at`, `revoked_at`.
- [ ] Publish accepts:
  - [ ] `signature` (base64) over `sha256(source) || ':' || name ||
'@' || version`.
  - [ ] `kid` (signing key id).
- [ ] Verification:
  - [ ] Look up `kid` in `signing_key`; refuse if revoked.
  - [ ] Verify Ed25519 signature.
  - [ ] Record `signed_by` and `signature` on the `class_version`
        row.
- [ ] Config: `requireSignedClasses: boolean` (default false).
- [ ] `actctl key add <pub.pem> --kid=...`,
      `actctl key revoke <kid>`,
      `actctl publish --sign <priv.pem>`.

### Rate limits & quotas

- [ ] Per-principal token bucket on `actor.call`:
  - [ ] Capacity + refill from config (per role; default
        `1000 calls / minute / user`).
  - [ ] Implementation: Valkey-side via `INCR` + EXPIRE, or a Lua
        token bucket; ADR decides.
  - [ ] 429 with `Retry-After` header.
- [ ] Per-class active-actor cap:
  - [ ] Tracked in Valkey gauge; new `create` rejected when over.
  - [ ] Returns 503 `CapacityExhausted`.
- [ ] Per-actor mailbox cap (3.1) confirmed wired and exposed via
      metrics.

### Cross-cutting

- [ ] All limit hits emit structured logs with reason + identifier
      so Phase 8 dashboards can alert on them.

### Tests

- [ ] Audit: every emit lands within a synchronous test assertion
      (drivers may use a flushable test mode).
- [ ] Signing happy path + each rejection mode (no sig, bad sig,
      revoked key).
- [ ] Rate limit: burst over capacity → 429; refill → succeed.
- [ ] Active-actor cap: create up to limit → 503 thereafter.

---

## Risks & watch-outs

- [ ] Audit must never silently fail. If the audit write fails,
      the action should fail too (configurable, but recommend the
      strict default).
- [ ] Signing keys leak. Mitigate with `kid` rotation; audit each
      rotation. Document the rotation procedure.
- [ ] Token-bucket Lua scripts can be wrong in subtle ways. Reuse a
      vetted implementation if one exists; otherwise property-test
      against a reference.
- [ ] Per-class active-actor caps are easy to set too low and cause
      a denial of service. Defaults should be generous; config-
      driven for production.
- [ ] S3 audit mirror writes are slow and not transactional with
      PG. Use an async queue with bounded retries; document the
      worst-case mirror lag.
