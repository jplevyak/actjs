# Authentication

actjs is **BYO authentication**. The framework does not ship an
identity provider, a session store, or a login UI. It accepts a
single hook — `auth(req)` — that turns each request into a
[`Principal`](#principal). Everything downstream (admin gating,
Phase 7 capabilities, audit) reads from that principal.

This document covers:

1. The Principal shape and where it surfaces.
2. Wiring `auth(req)` and the `requireAuth` flag.
3. The built-in helpers: `verifyJWT`, `verifyHmac`, `staticToken`.
4. Worked examples for JWT, HMAC, OAuth2, and "look it up in my own
   user table."
5. SSE/WebSocket considerations.
6. Operational notes (anonymous-default warnings, token rotation).

## Principal

```ts
interface Principal {
  sub: string; // stable subject id
  roles?: readonly string[]; // role names; 'admin' gates admin routes
  tenant?: string; // multi-tenant scope
  capabilities?: readonly string[]; // Phase 7b
  claims?: Record<string, unknown>; // free-form, opaque to actjs
}
```

`req.principal` is populated on every Fastify request handler.
When the auth hook is omitted entirely, the principal is
`{ sub: 'anonymous', roles: [] }`.

## Wiring `auth`

```ts
import { buildApp } from 'actjs/server/app.js';

const app = await buildApp({
  driver,
  runtime,
  auth: async (req) => {
    const token = bearer(req);
    if (!token) return null;
    return await myUserLookup(token);
  },
  requireAuth: true,
});
```

Semantics:

| `auth` returns | `requireAuth: false`                | `requireAuth: true`  |
| -------------- | ----------------------------------- | -------------------- |
| `Principal`    | request continues as that principal | same                 |
| `null`         | request continues as `anonymous`    | **401** Unauthorized |
| (throws)       | error handler maps to 401           | same                 |

Throwing a `StatusError(message, 401)` from inside `auth` is the
canonical way to signal a hard-reject (rather than returning `null`).

## Admin gating

Routes that mutate registry state require `roles: ['admin', ...]`:

- `POST /v1/classes/:name/versions` — publish.
- `PATCH /v1/classes/:name/versions/:v` — deprecate.
- `GET /v1/admin/manifests/in-use` — admin telemetry.
- `POST /v1/run`, `POST /v1/upload` — legacy scripting (will retire
  with the Phase 1 shim).

Authoring an admin role is your decision: actjs only checks for
the string `'admin'`. Map your IdP groups / scopes to it however
you like.

## Built-in verifiers

These exist so most users don't have to write `auth(req)` from
scratch. They cover the common cases and stop short of any IdP
specifics.

### `verifyJWT(options)`

```ts
import { verifyJWT } from 'actjs/server/auth.js';

const app = await buildApp({
  // ...
  auth: verifyJWT({
    jwksUrl: 'https://login.example.com/.well-known/jwks.json',
    issuer: 'https://login.example.com',
    audience: 'actjs',
  }),
  requireAuth: true,
});
```

- Looks for `Authorization: Bearer <token>`.
- Resolves the signing key against the JWKS URL (5-min cache).
- Supports `HS256`, `RS256`, `ES256`.
- Validates `exp` / `nbf` / `iss` / `aud`.
- Maps standard claims to a Principal:
  - `sub` → `sub` (required).
  - `roles` (array) **or** `scope` (space-delimited string) → `roles`.
  - `tenant` (string) → `tenant`.
  - `capabilities` (array) → `capabilities`.
  - Full claims object retained on `principal.claims`.

Pass `principalFromClaims` to override the mapping.

### `verifyHmac(secret, options?)`

Symmetric, useful for service-to-service traffic where both sides
share a secret:

```ts
import { verifyHmac } from 'actjs/server/auth.js';

const app = await buildApp({
  auth: verifyHmac(process.env.ACTJS_SERVICE_SECRET!),
});
```

The caller posts the Principal as base64-encoded JSON in
`X-Actjs-Principal` and the HMAC in `X-Actjs-Signature`:

```js
const principal = JSON.stringify({ sub: 'svc-billing', roles: ['admin'] });
const payload = Buffer.from(principal).toString('base64');
const sig = createHmac('sha256', SECRET).update(payload).digest('hex');
```

This does **not** handle replay protection. Add a timestamp claim
and a nonce store if you need that.

### `staticToken(map)`

For dev and tests:

```ts
import { staticToken } from 'actjs/server/auth.js';

const app = await buildApp({
  auth: staticToken({
    'ci-runner-key': { sub: 'ci-runner', roles: ['admin'] },
    'demo-user-key': { sub: 'demo-user', roles: ['member'] },
  }),
});
```

Do not use in production.

## Worked example: `@fastify/oauth2` upstream

If you already have `@fastify/oauth2` (or any other Fastify auth
plugin) decorating `req.user`, your `auth` hook is a one-liner:

```ts
const app = Fastify();
await app.register(oauth2, {
  /* your config */
});

const actjsApp = await buildApp({
  driver,
  runtime,
  auth: (req) => {
    const user = req.user as undefined | { id: string; roles: string[] };
    if (!user) return null;
    return { sub: user.id, roles: user.roles };
  },
});
```

The auth plugin runs upstream of `buildApp` because Fastify
preHandler hooks run in registration order; if your plugin needs
to be on the same app instance, register it before calling
`buildApp` (e.g., via `buildApp`'s returned instance — call
`app.register(oauth2)` and then re-wire the actjs auth hook).

## Worked example: BYO user table

```ts
const auth: AuthHook = async (req) => {
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey !== 'string') return null;
  const user = await db.users.findByApiKey(apiKey);
  if (!user || user.disabled) return null;
  return {
    sub: user.id,
    roles: user.roles,
    tenant: user.tenantId,
    claims: { email: user.email },
  };
};
```

## SSE & WebSocket considerations

### SSE: `EventSource` can't set headers

The `GET /v1/actors/:class/:id/events` route honors
`X-Actjs-Manifest` as a header AND `?manifest=<sha>` as a query
parameter. Use the query path only for `EventSource` clients in
the browser; everywhere else (Node, native HTTP) the header is
preferred so the sha doesn't leak into request logs and CDN caches.

For the same reason, **`EventSource` cannot send `Authorization`
headers**. Browsers that need auth on SSE typically either:

1. Issue a short-lived session cookie via a sibling endpoint and
   read it in your `auth(req)` hook.
2. Embed a one-shot token in the query string (e.g. `?token=...`).
   Treat query tokens as exposed in logs — rotate aggressively.

### WebSocket: close-code conventions

WS upgrades can't carry a `application/problem+json` body. The WS
endpoint uses close codes:

| Code | Meaning                               |
| ---- | ------------------------------------- |
| 1000 | Normal close                          |
| 1001 | Server going away / heartbeat timeout |
| 1008 | Policy violation (auth rejected)      |
| 4001 | Auth required (analogous to HTTP 401) |
| 4003 | Forbidden (analogous to HTTP 403)     |
| 4429 | Subscriber cap reached                |

Codes ≥ 4000 are application-defined and won't collide with the
WebSocket RFC. The actjs SDK maps them to error classes
analogous to the REST problem-detail codes.

## Operational notes

### Anonymous-default warning

If you start the server with no `auth` and `NODE_ENV` is anything
other than `development`/`test`, actjs prints:

```
actjs: no `auth` hook configured; every request will be anonymous.
```

This is the only nudge — actjs will not refuse to start.
Production setups should either:

- Pass an `auth` hook (preferred), or
- Place a reverse proxy in front that strips unauthenticated
  traffic and rewrites it into something your `auth` hook can
  consume.

### Token rotation

Because actjs is BYO, it never sees the rotation event. If your
JWKS, HMAC secret, or session schema changes, restart or hot-reload
the server. The built-in `verifyJWT` re-fetches JWKS every five
minutes, which usually absorbs key rotation transparently; HMAC
rotation requires a restart with the new secret unless you build
a custom hook that watches a key vault.

### Logging principals

`req.principal` is intentionally a simple shape so that it's
cheap to log without leaking PII. Avoid putting raw bearer tokens
or full claim payloads in `claims` if you log them downstream —
the framework will faithfully pass through whatever you return.

## See also

- [Phase 5.3 task](../tasks/phase-5-3-sse-auth.md)
- [Phase 5.3 ADR](../tasks/phase-5-3-sse-auth.adr.md)
- [Phase 7.1 — capabilities](../tasks/phase-7-1-policy-capabilities.md)
