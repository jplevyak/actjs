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
import { buildApp } from '@jplevyak/actjs/server/app.js';

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

Authoring an admin role is your decision: actjs only checks for
the string `'admin'`. Map your IdP groups / scopes to it however
you like.

## Policy + capabilities (Phase 7.1)

Auth says **who**. Policy says **what they can do**. Capabilities
let a class hand out narrow, time-bounded grants without minting a
full identity.

### Class `static policy()`

Any actor class can declare a `static policy()` method:

```ts
class OwnedNote extends actjs.Actor<{ ownerId: string; text: string }> {
  static policy(p: Principal, action: PolicyAction<OwnedNote>) {
    if (action.kind === 'create') return 'allow';
    if (action.kind === 'read' || action.kind === 'destroy') {
      return p.sub === action.actor.state.ownerId
        ? 'allow'
        : { allow: false, reason: 'only the owner can read or destroy' };
    }
    if (action.method === 'write') {
      return p.sub === action.actor.state.ownerId ? 'allow' : 'deny';
    }
    return 'deny';
  }
  /* ...handlers... */
}
```

Semantics:

- The runtime runs `policy()` **before** the message reaches the
  mailbox. A denied call never wakes the actor.
- `policy()` is **pure**: no `actjs.call`, no I/O. The runtime
  passes the action's `actor` as a read-only view; the host bridge
  isn't reachable from inside `policy()`.
- Decisions can be the literals `'allow'` / `'deny'` or an object
  `{ allow: boolean; reason?: string }`. The `reason` surfaces in
  the 403 problem-detail body so the caller knows _why_.
- If no `static policy()` is declared, the framework default is
  **allow** — trust your own classes. Opt into gating per class.

### Action kinds

| Kind      | Fields                                                             |
| --------- | ------------------------------------------------------------------ |
| `call`    | `{ method, args, actor: { ref, state } }`                          |
| `read`    | `{ actor: { ref, state } }` — fires on `GET /v1/actors/:c/:id`.    |
| `create`  | `{ args }` — fires on `POST /v1/actors/:c`.                        |
| `destroy` | `{ actor: { ref, state } }` — fires on `DELETE /v1/actors/:c/:id`. |

The `actor.state` field is the current materialized state. Use it
to compare against the principal (`ownerId === p.sub`), check
tenant scoping, or gate by tag.

### Worked example: shareable read links

Mint a capability inside a handler:

```ts
class Cart extends actjs.Actor<{ items: Item[]; ownerId: string }> {
  @handler('shareReadLink')
  shareReadLink(args: { ttlMinutes: number }): { token: string } {
    return {
      token: this.actjs.mintCapability({
        methods: ['call:total', 'call:listItems'],
        ttlMs: args.ttlMinutes * 60_000,
      }),
    };
  }

  @handler('total')
  total(): number {
    /* ... */
  }

  static policy(p: Principal, action: PolicyAction<Cart>) {
    if (action.kind !== 'call') return 'allow';
    if (action.method === 'shareReadLink') {
      return p.sub === action.actor.state.ownerId ? 'allow' : 'deny';
    }
    if (action.method === 'total' || action.method === 'listItems') {
      // Owner, OR a capability that includes call:<method>.
      if (p.sub === action.actor.state.ownerId) return 'allow';
      if (p.capabilities?.includes(`call:${action.method}`)) return 'allow';
      return 'deny';
    }
    return 'deny';
  }
}
```

A holder presents the token via `Authorization: Capability <jwt>`:

```bash
curl -X POST \
  -H "Authorization: Capability $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' \
  https://api.example.com/v1/actors/Cart/$id/total
```

Important: **do not put the token in a URL query string.** URLs land
in logs, Referer headers, browser histories, and CDN caches. Either
keep the token in the header on every call, or post it via a
`POST` body and have your frontend exchange it for a session
cookie.

### Capability claims

| Claim  | Meaning                                                             |
| ------ | ------------------------------------------------------------------- |
| `iss`  | Issuer string (set on `new Runtime({ capabilityIssuer })`).         |
| `sub`  | `"<class>:<id>"` — bound to the actor that minted it.               |
| `aud?` | Optional audience (free-form, opaque to the framework).             |
| `mth`  | Methods this grant covers; e.g. `["call:total", "call:listItems"]`. |
| `exp`  | Unix-second expiry; enforced on every verification.                 |
| `jti`  | UUID; used by the blocklist for revocation.                         |

Signing algorithm: **Ed25519** (`alg: 'EdDSA'`). The issuer
generates a fresh keypair at construction time unless you pass an
existing `KeyObject` via `new CapabilityIssuer({ privateKey, publicKey })`.

### Revocation

Capabilities can outlive their usefulness. Pass a blocklist to
`buildApp`:

```ts
import { MemoryBlocklist } from '@jplevyak/actjs/policy';

const blocklist = new MemoryBlocklist();
const app = await buildApp({ /* ... */, capabilityBlocklist: blocklist });

// Later:
blocklist.revoke(jti, expiresAtMs);
```

The blocklist is checked on every request that presents a
capability. The in-memory backend is single-node; multi-node
deployments should provide a `Blocklist` implementation backed by
Postgres or Redis (7.1b — the interface is stable).

Wrapping a remote blocklist in `CachedBlocklist` adds a per-jti
TTL (default 10 s) so the hot path doesn't take a round-trip on
every call. The documented worst-case revocation lag equals the
cache TTL.

### Operator checklist for capabilities

- **Issuer key persistence.** The default `new Runtime({ capabilityIssuer: new CapabilityIssuer({ issuer: 'my-app' }) })` generates a fresh keypair each process start, which invalidates every previously-minted token. For production, persist the private key (e.g. read from `KMS`) and pass it in.
- **TTL bounds.** The issuer enforces a max TTL of 24h by default. Lower it (`new CapabilityIssuer({ maxTtlMs })`) if your threat model needs shorter grants.
- **Audit.** Phase 7.2 will log each verified capability with `iss`/`jti`/`sub`/`mth` — the data is already on `req.capability` if you want to roll your own audit hook today.

## Built-in verifiers

These exist so most users don't have to write `auth(req)` from
scratch. They cover the common cases and stop short of any IdP
specifics.

### `verifyJWT(options)`

```ts
import { verifyJWT } from '@jplevyak/actjs/server/auth.js';

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
import { verifyHmac } from '@jplevyak/actjs/server/auth.js';

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
import { staticToken } from '@jplevyak/actjs/server/auth.js';

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
