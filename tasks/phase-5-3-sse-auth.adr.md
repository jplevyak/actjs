# ADR — Phase 5.3: SSE & BYO auth hook

> Task: [phase-5-3-sse-auth.md](./phase-5-3-sse-auth.md)
> Plan reference: [PLAN.md § Phase 5c/5d](../PLAN.md#phase-5--api-surface-fastify)

- **Status:** Accepted
- **Date:** 2026-05-20
- **Decider(s):** John Plevyak

## Context

SSE is a fallback transport for environments where WebSocket
doesn't survive (mobile background, restrictive proxies). The auth
hook is the only authentication mechanism actjs ships; everything
else is BYO. Decisions here are about the **boundary**, not the
substance, of authentication.

## Decision

### SSE manifest pin transport — **header preferred, query string accepted**

The `X-Actjs-Manifest` header path remains the primary surface (it
stays out of logs, caches, and Referer headers). Because browsers
cannot set arbitrary headers on `EventSource`, the pin hook also
accepts `?manifest=<sha>`. Other transports (Node, mobile, native
HTTP) MUST use the header; the docs lean on this hard.

Rejected alternatives:

- **Query only** — leaks the sha to every CDN/logging layer for
  every client, not just browser SSE.
- **Cookie-based** — couples SSE to a session-cookie auth scheme
  and complicates cross-origin clients.

### Anonymous-default behavior — **warn on startup, refuse never**

When `auth` is omitted and `NODE_ENV` is not `development` or
`test`, actjs prints a single-line warning to stderr but starts
normally. We deliberately do not refuse to boot:

- Many users run actjs behind a reverse proxy that handles auth.
- Refusing to start would force a placeholder `auth` hook into
  every production-y test or staging env.
- The warning is loud enough that an operator will see it during
  the first deploy and either fix it or document the choice.

The warning fires once per process. Future phases (8.1
observability) may also emit a `actjs_auth_anonymous_default`
metric.

### Built-in verifier coverage — **JWT + HMAC + staticToken**

We ship three:

- `verifyJWT(options)` — JWKS-backed, HS256/RS256/ES256. Most
  third-party IdPs (Auth0, Cognito, Keycloak, Azure AD, Google)
  speak this.
- `verifyHmac(secret)` — service-to-service.
- `staticToken(map)` — dev/test ergonomics.

Cookie verification is deliberately left to the caller's `auth`
hook because the cookie schema is too tied to the consumer's
session store.

### Principal shape — **structured (sub/roles/tenant/capabilities/claims)**

We chose a fixed, structured Principal rather than a generic
pluggable shape. The structure is the contract every Phase 5+
feature consumes — admin gating reads `roles`, Phase 7b will read
`capabilities`, audit logs will index by `sub`/`tenant`. A
free-form `claims` escape hatch carries everything else without
inflating the surface area.

We rejected:

- **Minimal (sub only)** — pushes downstream phases into ad-hoc
  claim parsing.
- **Pluggable via generics** — the principal flows through
  Fastify type augmentation and would require every consumer to
  pin the same generic; not worth the complexity for the small
  set of fields we actually want.

### Close-code conventions — **IANA range for transport, 4xxx for app**

WebSocket close codes 1000–1015 follow the RFC. We use:

| Code | Meaning                          |
| ---- | -------------------------------- |
| 1000 | Normal close                     |
| 1001 | Going away / heartbeat timeout   |
| 1008 | Policy violation (auth rejected) |
| 4001 | Auth required                    |
| 4003 | Forbidden                        |
| 4429 | Subscriber cap reached           |

App-defined codes start at 4000, leaving 3xxx for library
extensions (e.g., a future `actjs/client` SDK).

### Legacy `X-Actjs-Admin: 1` header — **kept as opt-in dev convenience**

The previous admin gate accepted this header unconditionally. We
keep it but only honor it when `NODE_ENV=development` or
`ACTJS_DEV_ADMIN_HEADER=1`. This preserves `demo.bash` and the
in-process test harness without weakening the production gate.

## Consequences

### Positive

- One auth surface (`auth(req)`) covers REST, WS, SSE, and any
  future transport.
- The framework has no opinion about your IdP. Migrating between
  Auth0 → Keycloak → "our own user table" is just a rewrite of
  one function.
- Built-in helpers handle the common cases without forcing a
  dependency tree.
- SSE shares the SubscriptionRegistry with WS, so the two
  transports are guaranteed to deliver the same event shape.

### Negative / trade-offs

- BYO auth means each consumer reinvents wiring. The docs and the
  worked examples are the antidote, but adoption requires the
  user to write code.
- Anonymous-by-default is dangerous if an operator misses the
  startup warning. We accept this risk in exchange for
  not-refusing-to-boot.
- JWKS rotation has a five-minute cache TTL. Operators who rotate
  faster need a custom `auth` hook.
- The HMAC verifier ships without replay protection. Operators
  who need it must layer a nonce store on top.
- The legacy `X-Actjs-Admin` dev header is a foot-gun if an
  operator accidentally sets `NODE_ENV=development` in prod. The
  alternative — deleting it — would break the demo.

### Follow-ups for later phases

- **Phase 7a (policy):** ship a tiny policy DSL that reads
  `principal.roles` / `tenant` / `capabilities` instead of
  hand-rolled checks at each route.
- **Phase 7b (capabilities):** define how capability tokens are
  minted, scoped, and revoked. `principal.capabilities` is the
  inbound carrier.
- **Phase 7c (audit):** emit `principal.sub` into every audit
  record. Decide whether `principal.claims` is also persisted (we
  lean toward no, to avoid PII spill).
- **Phase 8.1 (observability):** add the
  `actjs_auth_anonymous_default` and
  `actjs_admin_rejected_total` counters.
- **`actjs/client` SDK (Phase 6.2):** define an `onAuthExpired`
  hook so clients can refresh tokens transparently before
  reconnecting WS/SSE.

## Alternatives considered (and why not)

- **Ship a full IdP integration (e.g., Passport.js).** Couples
  actjs to a specific JS ecosystem; the same hook surface lets
  operators bring Passport themselves.
- **Refuse to boot without `auth`.** Too aggressive for the local
  dev flow and for setups with an auth-handling reverse proxy.
- **Use Fastify's `app.decorateRequest('principal', …)` only,
  without a hook.** Means every consumer wires the decoration
  themselves; we'd lose the central enforcement point.

## References

- [docs/auth.md](../docs/auth.md) — operator guide.
- [src/server/auth.ts](../src/server/auth.ts) — implementation.
- [src/server/routes/sse.ts](../src/server/routes/sse.ts) — SSE
  endpoint.
- [Phase 5.2 ADR](./phase-5-2-websocket-jsonrpc.adr.md) — WS
  framing the SSE format mirrors.
- [RFC 7807 — Problem Details for HTTP APIs](https://datatracker.ietf.org/doc/html/rfc7807)
- [WHATWG HTML — Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
