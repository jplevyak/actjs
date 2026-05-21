# Phase 7.1 — Policy & capabilities

> Source: [PLAN.md § Phase 7a/7b](../PLAN.md#phase-7--production-hardening)
> Decisions: [phase-7-1-policy-capabilities.adr.md](./phase-7-1-policy-capabilities.adr.md)

## Goal

Class-level `policy()` functions decide whether a `Principal` can
invoke a method on a given actor. Capability tokens let a server
mint short-lived, narrow grants for sharing — e.g. shareable read
links without a full auth flow.

## Done when

- [x] A class with `static policy(p, action) { ... }` denies a
      non-owner call with HTTP 403.
- [ ] A YAML default policy DSL covers owner-only, role-match, and
      tag-match rules without writing JS. _(Deferred to 7.1b; the
      JS surface is shipped and stable, the YAML compiler lands on
      top.)_
- [x] `actjs.mintCapability({ ttl, methods })` returns a JWT that,
      when passed as a token, satisfies the policy for the named
      methods on the actor that minted it.
- [x] A capability outlives its TTL → server rejects with 403
      `CapabilityExpired`.

---

## Checklist

### Policy interface

- [x] Class static:
  ```ts
  static policy(
    principal: Principal,
    action: PolicyAction<This>
  ): PolicyDecision
  ```
  where `PolicyAction` is one of:
  - `{ kind: 'call'; method: string; args: unknown; actor: PolicyActor<S> }`
  - `{ kind: 'read'; actor: PolicyActor<S> }`
  - `{ kind: 'create'; args: unknown }`
  - `{ kind: 'destroy'; actor: PolicyActor<S> }`
- [x] `PolicyDecision = 'allow' | 'deny' | { allow: boolean; reason?: string }`.
- [x] Default if absent: **allow** (default-allow when no policy is
      declared — see ADR for the reasoning, which diverges from
      the task's original "authenticated-only" default).

### Policy invocation point

- [x] Runtime checks policy _before_ the message hits the mailbox.
- [x] Policy is pure: the host bridge is not reachable from inside
      `policy()` (action carries a read-only `PolicyActor` view).
- [x] On deny: 403 with reason in problem detail (sanitized).

### Default policy DSL (YAML)

- [ ] A class can ship a sibling `Class.policy.yaml`. _(Deferred —
      7.1b. The expression-language pick goes in its own ADR; the
      runtime contract already accepts the compiled `PolicyFn`.)_

### Capability tokens

- [x] `actjs.mintCapability({ttl, methods, audience?})`:
  - [x] Issuer: server's signing key (Ed25519).
  - [x] Claims: `iss`, `sub` (actor ref), `aud?`, `mth`, `exp`, `jti`.
  - [x] Returns: JWT string (header.payload.signature, base64url).
- [x] Token presentation: `Authorization: Capability <jwt>`.
- [x] Verification: signature + `exp` + `nbf` + revocation check.
      Method-coverage is enforced via the policy reading
      `principal.capabilities`.
- [x] Verified capability augments the `Principal` with
      `capabilities: ['call:<method>', ...]`; policy code can
      reference them.
- [x] Revocation: in-memory `MemoryBlocklist` keyed by `jti`;
      `Blocklist` interface is stable so a PG-backed
      implementation can drop in. _(PG implementation deferred to
      7.1b.)_

### Tests

- [x] Static `policy()` denies non-owner; allows owner.
- [ ] YAML DSL: same scenarios, same observable behavior.
      _(Deferred with the DSL.)_
- [x] Capability happy path: mint, present, succeed.
- [x] Capability expired: rejected by the auth hook (status maps
      via the framework `CapabilityError`).
- [x] Capability for the wrong method: 403.
- [x] Capability blocklisted before exp: rejected.
- [x] Anonymous principal + no capability + non-default `policy()`:
      denied.

### Documentation

- [x] `docs/auth.md` policy + capabilities section with worked
      examples (owner-only class, capability mint inside a
      handler).
- [x] Cookbook: "shareable read link" — mint inside a handler,
      transmit via `Authorization: Capability` header (never URL).

---

## Risks & watch-outs

- [x] Policy logic that does I/O is a footgun. _(Enforced by
      passing a read-only `PolicyActor` view, not the host
      bridge.)_
- [x] YAML DSL needs guardrails. _(Deferred; ADR commits to CEL as
      the leading candidate.)_
- [x] Capability JWTs are bearer tokens. Documented as
      header-only in `docs/auth.md`; cookbook example uses
      `Authorization: Capability`, not the URL.
- [x] Blocklist read on every request adds latency. _(Documented;
      `CachedBlocklist` provides a 10-s default TTL wrapper for
      remote backends.)_
- [x] `policy()` runs in the request hot path. _(Pure function over
      structured inputs; no decoration tax. A Phase 8.1 follow-up
      adds the `policy_eval_ms` histogram.)_
