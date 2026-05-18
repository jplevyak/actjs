# Phase 5.3 — SSE fallback & BYO auth hook

> Source: [PLAN.md § Phase 5c/5d](../PLAN.md#phase-5--api-surface-fastify)
> Decisions: [phase-5-3-sse-auth.adr.md](./phase-5-3-sse-auth.adr.md)

## Goal

Two final pieces of the API surface: an SSE fallback for clients
that can't keep a WebSocket up, and the BYO `auth(req)` hook that
turns a request into a `Principal` for every later phase to use.

## Done when

- `GET /v1/actors/:class/:id/events` streams the same event format
  as WS subscriptions.
- A consumer that configures `fastify.actjs({ auth: ... })` sees
  `req.principal` populated on every authenticated route.
- The legacy admin endpoints (`/v1/run`, `POST /v1/classes/.../versions`)
  reject requests without admin claims.
- Removing the auth hook is allowed for local dev and produces a
  default `Anonymous` principal.

---

## Checklist

### SSE endpoint

- [ ] `GET /v1/actors/:class/:id/events`:
  - [ ] Sets `Content-Type: text/event-stream`.
  - [ ] Sends initial `snapshot` event.
  - [ ] Subsequent events use the same wire shape as WS notifications
        (`kind: 'patch' | 'event' | 'snapshot' | 'tombstone'`),
        serialized as `event: actor.event\ndata: <json>\n\n`.
  - [ ] Honors `Last-Event-ID` for ES replay on reconnect.
- [ ] Keep-alive comments (`:keepalive\n\n`) every 25 s to
      keep proxies happy.
- [ ] Close on client disconnect; clean up the subscription
      registration.
- [ ] Manifest pin via query string (`?manifest=<sha>`) or header,
      since browsers can't set arbitrary headers on `EventSource`.

### Auth hook surface

- [ ] `fastify.actjs({ auth, requireAuth? })`:
  - [ ] `auth(req): Promise<Principal | null>` — called once per
        request; called on WS upgrade for the connection lifetime.
  - [ ] If `auth` omitted: every request gets `Principal.anonymous`.
  - [ ] If `auth` returns `null` and `requireAuth: true`: 401.
- [ ] `Principal` type:
  ```ts
  interface Principal {
    sub: string;
    roles?: readonly string[];
    tenant?: string;
    capabilities?: readonly string[]; // for Phase 7b
    claims?: Readonly<Record<string, unknown>>;
  }
  ```
- [ ] Built-in helpers (no IdP coupling):
  - [ ] `verifyJWT(jwksUrl)`.
  - [ ] `verifyHmac(sharedSecret)`.
  - [ ] `staticToken(map)` for tests/dev.

### Admin gating

- [ ] `/v1/run` requires `principal.roles?.includes('admin')`.
- [ ] `POST /v1/classes/:name/versions` same.
- [ ] `PATCH /v1/classes/:name/versions/:v` same.
- [ ] Other admin-only routes documented in a single table consumed
      by the OpenAPI annotator.

### Tests

- [ ] SSE delivers the same sequence as WS for the same actor.
- [ ] `Last-Event-ID` replay for ES is exact.
- [ ] Auth hook receives the request; `req.principal` available on
      every downstream handler.
- [ ] Missing `requireAuth` + no `auth` hook: anonymous works.
- [ ] `requireAuth: true` + no token: 401.
- [ ] Admin route from non-admin token: 403.

### Documentation

- [ ] `docs/auth.md` showing how to wire JWT, HMAC, and "verify
      against my own user table" patterns.
- [ ] Worked example: Fastify app with `@fastify/oauth2` upstream of
      `fastify.actjs`.

---

## Risks & watch-outs

- [ ] SSE behind a buffering proxy will batch events. `X-Accel-
Buffering: no` for nginx; ADR records the headers to set
      against well-known proxies.
- [ ] Manifest pin via query string is visible in logs and caches.
      Recommend the header path; allow query only for `EventSource`.
- [ ] Anonymous-by-default is dangerous in production. The ADR
      should commit to a startup-time warning when `auth` is
      unset and `NODE_ENV !== 'development'`.
- [ ] BYO auth means we don't see token rotation. Mention this in
      docs so operators know what's their problem vs ours.
- [ ] WS upgrade can't easily return a problem-detail body; close
      codes are the only signal. Document the code table.
