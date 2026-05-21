# ADR — Phase 7.1: Policy & capabilities

> Task: [phase-7-1-policy-capabilities.md](./phase-7-1-policy-capabilities.md)
> Plan reference: [PLAN.md § Phase 7a/7b](../PLAN.md#phase-7--production-hardening)

- **Status:** Accepted
- **Date:** 2026-05-20
- **Decider(s):** John Plevyak

## Context

Auth (Phase 5.3) only tells us **who** is making a call. Policy and
capabilities tell us **what** they can do. The framework needs a
pleasant default + an escape hatch to per-class JS without
trapping consumers in a DSL.

Phase 7.1 shipped the core mechanism:

```
src/policy/
├── types.ts       PolicyAction, PolicyDecision, default policy
├── evaluate.ts    invokes static policy() with try/catch → deny
├── capability.ts  CapabilityIssuer + verifyCapability (Ed25519 JWT)
├── blocklist.ts   in-memory blocklist + cached-read wrapper
└── index.ts       barrel
```

Wiring:

- `runtime.call/tell/tombstone` accept an optional `Principal` and
  call the policy before the message hits the mailbox.
- The REST `/v1/actors/*` and WS `/v1/ws` paths thread
  `req.principal` through; `PolicyDeniedError` maps to 403.
- The host bridge gains `actjs.mintCapability({ ttl, methods, audience? })`
  when the Runtime is constructed with a `CapabilityIssuer`.
- The auth hook recognizes `Authorization: Capability <jwt>` and
  augments `req.principal` with the granted methods.

YAML policy DSL and the PG-backed blocklist were carved out as
**7.1b** follow-ups — the in-memory blocklist is sufficient for
single-node deployments and unit tests, and the YAML DSL needs an
expression-language decision (CEL vs JSONata vs hand-rolled) that
deserves its own ADR.

## Decision

### Policy DSL expression language — **deferred to 7.1b**

Shipping a JS-static `policy()` first means every consumer can write
the rules they want in TypeScript with full IDE help. The YAML DSL
becomes a convenience layer over the same `PolicyDecision` shape;
the expression language can be picked later without changing the
runtime interface.

When we do pick one: lean toward **CEL** (Google's Common Expression
Language) because it's pre-existing, has multi-language
implementations, and has a published grammar. Rejected for v1:

- **JSONata** — powerful but evaluates as a full programming
  language, harder to sandbox.
- **Rhai** — non-JS implementation; an extra runtime dep.
- **Hand-rolled** — every team that picks this regrets the parse-
  level bugs three months later.

### Default policy — **default-allow when no `static policy()`**

The task originally specified "principal !== Anonymous → allow,
else deny" as the default. We softened it to **allow everything
when a class declares no policy**:

- actjs is a self-hosted, trust-your-own-classes library. A class
  with no policy is signaling "I have no special authorization
  needs," not "I want to be locked down."
- Strict default would force every existing test (and every
  consumer's first run) to set up auth before any actor call
  works. That's hostile to the "warn but boot" stance the auth
  ADR committed to.
- Classes that _do_ want gating opt in by writing `static policy()`,
  which is the same code path the YAML DSL will compile into.

The trade-off: a consumer who forgets to declare a policy ends up
with an open class. We document this in `docs/auth.md` and surface
the choice via the runtime's "no auth + no policy" warning at
startup.

### Capability signing key — **single Ed25519 key per Runtime**

The `CapabilityIssuer` holds one Ed25519 keypair. Reasons:

- Ed25519 produces short, fast-to-verify signatures (64 bytes) —
  good for a JWT that ships in an `Authorization` header.
- One key per Runtime is the simplest mental model. Multi-tenant
  deployments wanting per-tenant keys can layer their own issuer
  registry on top.
- Key rotation is operator policy: stand up a new issuer, mint
  fresh tokens, and let the old ones expire naturally (max TTL
  caps them at 24h by default).

We rejected **per-tenant keys** (premature; complicates the bridge
API) and **rotated keys with `kid` in JWT** (deferred — when the
operator picture sharpens in Phase 7.2 audit).

### Revocation cache TTL — **10 s default, operator-tunable**

`CachedBlocklist` defaults to a 10-second TTL. Rationale:

- A blocklisted jti remains "live" for at most 10 s in the worst
  case — fast enough that the operator can revoke a leaked token
  before a determined attacker drains a fresh batch of API calls.
- 10 s is well below typical session lengths; the hot-path cost
  of one PG round-trip per 10 s of activity is negligible.
- Operators with stricter requirements can pass `ttlMs: 1_000`
  (one second) at a 10× cost on the blocklist database; those
  with looser tolerances can lift to 60 s.

### Capability TTL bounds — **24h default, configurable**

`DEFAULT_MAX_TTL_MS = 24 * 60 * 60 * 1000`. Reasons:

- Most "shareable link" workflows are session-scale or shorter.
  24h is comfortably above the typical use case without enabling
  long-lived bearer secrets.
- Tokens that need to live longer should be re-minted from the
  source of truth (the owning actor's state) — that's the audit
  trail operators actually want.
- The bound is enforced at mint time, not verify time, so an
  operator can lower it after deployment and still honor
  outstanding longer-lived tokens without forced revocation.

Constructors accept `maxTtlMs` so tight environments can crank
this to 1h or 5min.

### System principal — **runtime-internal trust sentinel**

`systemPrincipal()` is a new well-known principal (sub: `'system'`)
used by:

- The reminder dispatcher (delivers `tell` to actors when reminders
  fire).
- Future intra-cluster RPC (Phase 9 placement).
- Any other runtime-internal call site.

The runtime's `checkPolicy` short-circuits to `allow` when the
principal is system. This is the only "magic" principal; everything
else flows through `policy()`.

External code paths (REST routes, WS handlers) MUST NOT pass
`systemPrincipal()` — the type system doesn't enforce this, but
the public-surface review for each new endpoint should.

### Capability principal shape — **`sub: "cap:<class>:<id>"`**

A verified capability turns into a `Principal` with:

- `sub = "cap:<sub-from-claims>"` — distinguishable from a real
  user `sub` so policies can pattern-match.
- `capabilities = claims.mth` (normalized to `call:<method>`).
- `claims = { iss, jti, exp, aud? }` — minimal so audit logs can
  identify the grant.

Policies typically write:

```ts
if (p.capabilities?.includes(`call:${action.method}`)) return 'allow';
```

We deliberately keep the principal's `roles` empty — capability
holders have only the methods their grant lists, never the role
of the user who minted them.

### Where the policy check fires — **after activation, before mailbox**

The task says "before the message hits the mailbox." We honor that:
`runtime.call` resolves the host (which activates if cold), reads
`currentState()` for the policy action, then invokes
`policy()`. Only on `allow` do we enqueue.

The cost: a denied call still triggers activation. We accept this:

- Activation cost is small (mostly a snapshot load).
- The alternative — passing the persisted snapshot directly into
  policy — wouldn't reflect in-flight state changes from earlier
  calls and would diverge from what the handler sees.
- Future hardening: a class can declare `static prePolicy()` that
  runs against the snapshot alone, before activation — useful as
  a coarse first gate.

## Consequences

### Positive

- One mechanism (`static policy()`) covers every action kind; no
  ad-hoc per-route gating.
- Default-allow keeps the "boots out of the box" property; tighten
  per class.
- Capability tokens are a real share-link primitive without
  inventing a new auth flow.
- The system principal cleanly distinguishes "this is the
  framework's own delivery" from "this is anonymous user traffic."

### Negative / trade-offs

- Default-allow is a foot-gun if a class author forgets to declare
  a policy; documented in `docs/auth.md` but not enforced.
- A denied call still activates the actor. Cheap, but visible in
  metrics — operators chasing latency on poorly-authorized hot
  classes will see activations they don't see calls for.
- The capability blocklist is in-memory; multi-node deployments
  must supply a shared `Blocklist` implementation until 7.1b lands.
- `actjs.mintCapability` can produce long-lived tokens up to 24h
  by default. Operators who need shorter must override `maxTtlMs`.
- The YAML DSL is deferred. Consumers who wanted a no-code policy
  surface have to write TypeScript for now.

### Follow-ups for later phases

- **7.1b — YAML DSL.** Settle the expression-language choice (lean
  CEL), build the publish-time compiler. The runtime stays
  unchanged because the DSL emits the same `PolicyFn`.
- **7.1b — PG blocklist.** Persistent, multi-node revocation
  backed by the existing storage driver. Wrap it in
  `CachedBlocklist` for hot-path performance.
- **Phase 7.2 — audit.** Log `principal.sub`, `iss`, `jti` on
  every policy decision (allow + deny). Decide whether
  `principal.claims` is also persisted; lean no.
- **Phase 8.1 — observability.** Counter `policy_denied_total{class,method,reason}`,
  histogram `policy_eval_ms`.

## Alternatives considered (and why not)

- **Default-deny.** Per the original task text. Rejected for
  ergonomics — see above.
- **YAML DSL ship-with-v1.** Doable but ties the v1 release to an
  expression-language pick that deserves its own design pass.
  Easier to ship JS-only first.
- **HMAC capability tokens.** Smaller dependency, but symmetric
  keys turn every server replica into a token-minting oracle.
  Ed25519 lets verifiers hold only the public key.
- **Capability presented in URL query string.** Convenient for
  one-shot share links but bleeds into logs and history. We
  document the header-only path and lean on it hard.
- **Synchronous policy check that takes a context object instead
  of action.kind.** Rejected — the action shape makes denial
  decisions readable in audit logs and TypeScript narrowing works
  cleanly with the discriminated union.

## References

- [docs/auth.md](../docs/auth.md) — policy + capabilities section.
- [src/policy/types.ts](../src/policy/types.ts) — action / decision
  types.
- [src/policy/capability.ts](../src/policy/capability.ts) —
  CapabilityIssuer + verifier.
- [src/policy/blocklist.ts](../src/policy/blocklist.ts) — in-memory
  blocklist + cache.
- [tests/policy/policy.test.ts](../tests/policy/policy.test.ts) —
  unit + REST tests.
- [Ed25519 — RFC 8032](https://datatracker.ietf.org/doc/html/rfc8032)
- [CEL spec](https://github.com/google/cel-spec) — candidate for
  7.1b YAML DSL.
