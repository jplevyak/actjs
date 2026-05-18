# ADR — Phase 5.3: SSE & BYO auth hook

> Task: [phase-5-3-sse-auth.md](./phase-5-3-sse-auth.md)
> Plan reference: [PLAN.md § Phase 5c/5d](../PLAN.md#phase-5--api-surface-fastify)

- **Status:** Proposed
- **Date:** _TBD_
- **Decider(s):** _TBD_

## Context

_SSE is a fallback transport for environments where WebSocket
doesn't survive (mobile background, restrictive proxies). The auth
hook is the only authentication mechanism actjs ships; everything
else is BYO. Decisions here are about the boundary, not the
substance, of authentication._

## Decision

Likely decisions to settle here:

### SSE manifest pin transport

- Options: query string only, custom header (requires proxy work),
  cookie-based.
- Choice: _TBD_

### Anonymous-default behavior

- Options: warn on startup, refuse on non-dev, refuse always,
  allow silently.
- Choice: _TBD_

### Built-in verifier coverage

- Options: JWT + HMAC only, JWT + HMAC + cookie, none (pure BYO).
- Choice: _TBD_

### Principal shape

- Options: minimal (sub only), structured (roles/tenant/claims),
  pluggable via generics.
- Choice: _TBD_

### Close-code conventions

- Options: `4xxx` custom range, IANA-recommended only, mix.
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
