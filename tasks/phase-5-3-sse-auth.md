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

- [x] `GET /v1/actors/:class/:id/events`:
  - [x] Sets `Content-Type: text/event-stream`.
  - [x] Sends initial `snapshot` event.
  - [x] Subsequent events use the same wire shape as WS notifications
        (`kind: 'patch' | 'event' | 'snapshot' | 'tombstone'`),
        serialized as `event: actor.event\ndata: <json>\n\n`.
  - [x] Honors `Last-Event-ID` for ES replay on reconnect.
- [x] Keep-alive comments (`:keepalive\n\n`) every 25 s to
      keep proxies happy.
- [x] Close on client disconnect; clean up the subscription
      registration.
- [x] Manifest pin via query string (`?manifest=<sha>`) or header,
      since browsers can't set arbitrary headers on `EventSource`.

### Auth hook surface

- [x] `buildApp({ auth, requireAuth? })`:
  - [x] `auth(req): Promise<Principal | null>` — called once per
        request; called on WS upgrade for the connection lifetime.
  - [x] If `auth` omitted: every request gets `Principal.anonymous`.
  - [x] If `auth` returns `null` and `requireAuth: true`: 401.
- [x] `Principal` type:
  ```ts
  interface Principal {
    sub: string;
    roles?: readonly string[];
    tenant?: string;
    capabilities?: readonly string[]; // for Phase 7b
    claims?: Readonly<Record<string, unknown>>;
  }
  ```
- [x] Built-in helpers (no IdP coupling):
  - [x] `verifyJWT(jwksUrl)`.
  - [x] `verifyHmac(sharedSecret)`.
  - [x] `staticToken(map)` for tests/dev.

### Admin gating

- [x] `/v1/run` requires `principal.roles?.includes('admin')`.
- [x] `POST /v1/classes/:name/versions` same.
- [x] `PATCH /v1/classes/:name/versions/:v` same.
- [x] Other admin-only routes documented in a single table consumed
      by the OpenAPI annotator. _(Captured in [docs/auth.md](../docs/auth.md#admin-gating); annotator pickup is a Phase 6.1 follow-up.)_

### Tests

- [x] SSE delivers the same sequence as WS for the same actor.
- [x] `Last-Event-ID` replay for ES is exact.
- [x] Auth hook receives the request; `req.principal` available on
      every downstream handler.
- [x] Missing `requireAuth` + no `auth` hook: anonymous works.
- [x] `requireAuth: true` + no token: 401.
- [x] Admin route from non-admin token: 403.

### Documentation

- [x] `docs/auth.md` showing how to wire JWT, HMAC, and "verify
      against my own user table" patterns.
- [x] Worked example: Fastify app with `@fastify/oauth2` upstream of
      `fastify.actjs`.

---

## Risks & watch-outs

- [x] SSE behind a buffering proxy will batch events.
      `X-Accel-Buffering: no` for nginx; ADR records the headers to
      set against well-known proxies.
- [x] Manifest pin via query string is visible in logs and caches.
      Recommend the header path; allow query only for `EventSource`.
- [x] Anonymous-by-default is dangerous in production. The ADR
      should commit to a startup-time warning when `auth` is
      unset and `NODE_ENV !== 'development'`.
- [x] BYO auth means we don't see token rotation. Mention this in
      docs so operators know what's their problem vs ours.
- [x] WS upgrade can't easily return a problem-detail body; close
      codes are the only signal. Document the code table.
