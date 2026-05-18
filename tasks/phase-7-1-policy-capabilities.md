# Phase 7.1 — Policy & capabilities

> Source: [PLAN.md § Phase 7a/7b](../PLAN.md#phase-7--production-hardening)
> Decisions: [phase-7-1-policy-capabilities.adr.md](./phase-7-1-policy-capabilities.adr.md)

## Goal

Class-level `policy()` functions decide whether a `Principal` can
invoke a method on a given actor. Capability tokens let a server
mint short-lived, narrow grants for sharing — e.g. shareable read
links without a full auth flow.

## Done when

- A class with `static policy(p, action) { ... }` denies a
  non-owner call with HTTP 403.
- A YAML default policy DSL covers owner-only, role-match, and
  tag-match rules without writing JS.
- `actjs.mintCapability({ ttl, methods })` returns a JWT that, when
  passed as a token, satisfies the policy for the named methods on
  the actor that minted it.
- A capability outlives its TTL → server rejects with 403
  `CapabilityExpired`.

---

## Checklist

### Policy interface

- [ ] Class static:
  ```ts
  static policy(
    principal: Principal,
    action: PolicyAction<This>
  ): PolicyDecision
  ```
  where `PolicyAction` is one of:
  - `{ kind: 'call'; method: string; args: unknown; actor: ThisActor }`
  - `{ kind: 'read'; actor: ThisActor }`
  - `{ kind: 'create'; args: unknown }`
  - `{ kind: 'destroy'; actor: ThisActor }`
- [ ] `PolicyDecision = 'allow' | 'deny' | { allow: boolean; reason?: string }`.
- [ ] Default if absent: `principal !== Anonymous` → allow, else deny.

### Policy invocation point

- [ ] Runtime checks policy *before* the message hits the mailbox.
- [ ] Policy is pure: no `actjs.call`, no I/O. Document and enforce
      by withholding host APIs in the call frame.
- [ ] On deny: 403 with reason in problem detail (sanitized).

### Default policy DSL (YAML)

- [ ] A class can ship a sibling `Class.policy.yaml`:
  ```yaml
  defaults:
    call: deny
  rules:
    - allow: [read]
      when: principal.sub == actor.state.ownerId
    - allow: [call:addItem]
      when: 'admin' in principal.roles
  ```
- [ ] Compiler turns this into a `PolicyDecision` function at
      publish time. A class with both the YAML and a static
      `policy()` is a publish error.

### Capability tokens

- [ ] `actjs.mintCapability({ttl, methods, audience?})`:
  - [ ] Issuer: server's signing key (Ed25519).
  - [ ] Claims: `iss`, `sub` (actor ref), `aud?`, `methods`, `exp`.
  - [ ] Returns: JWT string.
- [ ] Token presentation: `Authorization: Capability <jwt>`.
- [ ] Verification: signature + `exp` + `methods` covers the
      requested method.
- [ ] Verified capability augments the `Principal` with
      `capabilities: [<methods>]`; policy code can reference them.
- [ ] Revocation: a minted-capabilities table in PG keyed by JWT id;
      a `DELETE` row blocklists a JWT before its `exp`.

### Tests

- [ ] Static `policy()` denies non-owner; allows owner; logs the
      reason in audit.
- [ ] YAML DSL: same scenarios, same observable behavior.
- [ ] Capability happy path: mint, present, succeed.
- [ ] Capability expired: 403.
- [ ] Capability for the wrong method: 403.
- [ ] Capability blocklisted before exp: 403.
- [ ] Anonymous principal + no capability + no `policy()`: denied.

### Documentation

- [ ] `docs/auth.md` (started in 5.3) gets a "policy + capabilities"
      section with worked examples.
- [ ] Cookbook: "shareable read link" — mint capability with
      `methods: ['read']`, encode in URL, FE presents it.

---

## Risks & watch-outs

- [ ] Policy logic that does I/O is a footgun (latency on every
      call). Enforce purity: pass the host bridge to handlers but
      not to `policy()`.
- [ ] YAML DSL needs guardrails — recommend a small expression
      language (e.g. CEL or JSONata-subset), not arbitrary JS. The
      ADR settles which.
- [ ] Capability JWTs are bearer tokens. Document that they should
      not be put in URLs that get logged. The cookbook example
      should show a `Authorization` header or a `POST` body, not a
      GET URL.
- [ ] Blocklist read on every request adds latency. Cache with a
      short TTL; document the worst-case revocation lag in the ADR.
- [ ] `policy()` runs in the request hot path. Snapshot tests for
      decision tables; CI runs a microbenchmark and fails on a
      regression.
