# Chapter 12 — Auth + `policy()`

> **Chapter goal:** plug in the BYO `auth(req)` hook so every
> request carries a `Principal`, then add `static policy(p,
action)` checks to the three actor classes so a player can
> only control their own character. Open the dev console and
> try to forge a move as another player — get a `403
PolicyDenied` for your trouble.
>
> **Time budget:** ~70 minutes.
>
> **End-of-chapter tag:** `ch12-done`.

---

Eleven chapters in, the dungeon has no authorization at all.
Any browser that knows another player's id can `POST
/v1/actors/Room/<roomId>/move` with that id in the body and
move them. Garrick will sell to anyone claiming any player id.
The tutorial's "two browsers, two players" demos have been
honor-system the whole time.

This chapter is where that ends. Two pieces of plumbing:

- **Authentication** turns a request into a `Principal` —
  "who is calling?" actjs ships no opinion on _how_ you
  authenticate; you provide an `auth(req)` hook and the
  framework calls it on every request. The Principal it
  returns lands on `req.principal`.
- **Authorization** is per-class. Each actor class can
  declare a `static policy(principal, action)` method; the
  runtime calls it before dispatching a handler. The policy
  says yes or no.

Each layer is small. The big idea is the separation: auth is
your service's choice (Bearer, JWT, OAuth, mTLS, session
cookies — actjs doesn't care). Policy is the actor class's
choice — and gets the typed view of the actor it's gating.

By the end of this chapter you will:

- Have a minimal `auth(req)` hook that reads
  `Authorization: Bearer <playerId>` and produces a
  `Principal` whose `sub` is the player's actor id.
- Have the browser sending that header on every request, plus
  `?token=<playerId>` on the WebSocket upgrade.
- Have `static policy()` on `Room`, `Player`, and `Merchant`
  enforcing: "the entity in `args.playerId` must equal
  `principal.sub`."
- Have demonstrated, via the dev console, that cross-player
  forgery returns `403 PolicyDenied` with a structured
  reason.

## The two layers

Authentication and authorization are different jobs. Mixing
them up is the most common security failure mode in a backend.

| Layer          | Question              | Where it lives                                | What it produces          |
| -------------- | --------------------- | --------------------------------------------- | ------------------------- |
| Authentication | Who is calling?       | `auth(req)` hook — operator-supplied          | A `Principal` (or `null`) |
| Authorization  | Is this call allowed? | `static policy(p, action)` on the actor class | `'allow'` or `'deny'`     |

The `auth` hook runs **once per request**. The `policy()`
check runs **once per handler invocation** — including
in-process ones if they hit the runtime boundary, though
cross-actor `this.actjs.call(...)` deliberately bypasses
policy (more on this in a moment).

## The BYO auth hook

For the tutorial we use the simplest possible scheme:
**`Authorization: Bearer <playerId>`**. The bearer token is
literally the player's actor id. The auth hook reads it,
trusts it, and produces a Principal:

```ts
sub: <playerId>
roles: []
```

This is **demonstrably insecure**: anyone who knows your
player id can claim to be you. The real fix is to verify a
signed JWT or look up a session token in a store. We're not
doing that in this chapter because the chapter is about
`policy()`, not about JWT signing.

In production, you'd write something like:

```ts
const auth: AuthHook = async (req) => {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return null;
  return verifyJwt(m[1]!); // your real verifier
};
```

For the tutorial it's:

```ts
const auth: AuthHook = (req) => {
  // Read the Bearer token from the Authorization header (REST)
  // or from the ?token=… query string (WS upgrade — browsers
  // can't set arbitrary headers on a WebSocket connect).
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const m = /^Bearer (.+)$/.exec(header);
    if (m) return { sub: m[1]!, roles: [] };
  }
  const q = req.query as { token?: string } | undefined;
  if (q?.token) return { sub: q.token, roles: [] };
  return null;
};
```

Open `src/server.ts` and add the hook plus the `buildApp`
wiring:

```ts
import type { AuthHook } from '@jplevyak/actjs/server';

// ... existing imports + driver + runtime ...

const auth: AuthHook = (req) => {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const m = /^Bearer (.+)$/.exec(header);
    if (m) return { sub: m[1]!, roles: [] };
  }
  const q = req.query as { token?: string } | undefined;
  if (q?.token) return { sub: q.token, roles: [] };
  return null;
};

const app = await buildApp({ driver, runtime, auth });
```

That's the whole authentication layer. Every request now lands
in handlers with `req.principal` populated. If no token is
present, `req.principal` is `{ sub: 'anonymous', roles: [] }`
— the framework's default.

## Browser changes

The browser already knows its player id (it's been in
`localStorage` since chapter 07). It needs to send it as the
bearer on every request and as `?token=` on the WebSocket
upgrade.

Update `public/main.js`'s `rpc` helper:

```js
async function rpc(path, body = {}) {
  const playerId = localStorage.getItem('actjs.playerId');
  const headers = { 'content-type': 'application/json' };
  if (playerId) headers.authorization = `Bearer ${playerId}`;
  const res = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}
```

And the WebSocket connect URL:

```js
const playerId = await getOrMintPlayer();
const wsUrl = `${location.origin.replace(/^http/, 'ws')}/v1/ws?token=${encodeURIComponent(playerId)}`;
const client = new WsClient(wsUrl);
await client.connect();
```

Two notes:

- **`getOrMintPlayer` must run before the WS URL is built.**
  The token is part of the URL; we can't backfill it after
  connect. The chapter-07 + chapter-08 flow already had
  `getOrMintPlayer` near the top of `main()`, so this is a
  one-line move.
- **Minting (`POST /v1/actors/Player`) doesn't need auth.**
  The mint endpoint creates a fresh actor id; there's no
  existing identity to gate against. The auth hook returns
  null on the mint call (no token yet), the principal
  becomes anonymous, and (since no policy is in the way of
  mint) the call succeeds.

## `static policy()` on each actor class

Now the authorization layer. We add a `static policy(p,
action)` method to each actor class. The runtime calls it
before dispatching any handler.

The signature:

```ts
static policy(
  p: Principal,
  action: PolicyAction<S>,   // S = this class's state type
): PolicyDecision;
```

`PolicyAction` is a discriminated union covering call, read,
create, and destroy. For our needs we only care about the
`call` kind. `PolicyDecision` is `'allow' | 'deny' | { allow,
reason? }`.

Three patterns we'll use:

- **Owner check.** "The `playerId` in args must equal
  `p.sub`."
- **Internal-only check.** "This handler can only be invoked
  by the system principal. Any human-driven call is denied."
- **Default allow.** Anything not specifically listed
  passes through.

The system principal bypasses policy entirely — the runtime
short-circuits with `if (isSystem(effective)) return` before
calling `evaluatePolicy`. So "internal handlers" don't need
to allowlist the system caller; we just deny everything else.

The other bypass: **cross-actor `this.actjs.call(ref, ...)`
doesn't run through the policy check.** Trust between actors
is bidirectional by design — once you're inside a handler,
you've been authorized to be there. The policy gates the
_boundary_ (REST + WS), not the internal call graph.

This is why the merchant's `purchase` handler can freely
call `Player.addItem` without re-authenticating. And it's
why a malicious POST directly to `Player.<id>/addItem`
would be denied by `Player.policy` — that's the boundary.

### Room.policy

Open `src/room.ts` and add a `static policy` method to the
`Room` class:

```ts
import { PolicyDeniedError, type PolicyAction, type PolicyDecision } from '@jplevyak/actjs/policy';
import type { Principal } from '@jplevyak/actjs/types';
// ... existing imports ...

export class Room extends Actor<RoomState> {
  static policy(p: Principal, action: PolicyAction<RoomState>): PolicyDecision {
    if (action.kind !== 'call') return 'allow';

    // Handlers that mutate a specific player's entity must be
    // called by that player. The runtime's reminder dispatcher
    // uses the system principal, which bypasses this check.
    const ownerOnly = ['move', 'addEntity', 'removeEntity'];
    if (ownerOnly.includes(action.method)) {
      const args = action.args as { playerId?: string };
      if (args.playerId !== p.sub) {
        return {
          allow: false,
          reason: `${action.method}: principal ${p.sub} cannot act as ${args.playerId}`,
        };
      }
    }

    // Internal handlers — called by the merchant (cross-actor,
    // bypassing policy) or by the system principal (also bypassing).
    // Anything reaching here is a direct external call; deny.
    const internalOnly = ['addMerchantPresence', 'tick'];
    if (internalOnly.includes(action.method)) {
      return { allow: false, reason: `${action.method}: internal handler` };
    }

    // read, tileAt, and any future read-shaped handlers fall
    // through to allow. Anonymous reads of the room are fine
    // for this tutorial; production might tighten further.
    return 'allow';
  }

  // ... existing handlers ...
}
```

A pause for the careful reader:

- **The order of decisions matters.** Owner-checked handlers
  fire first; if the method isn't in that list, we fall
  through to the internal-handler deny list; if it's not in
  that either, we allow. This is the standard "deny by name,
  allow the rest" pattern. The default-allow makes the policy
  small; the explicit denies make the boundary tight.
- **`PolicyDeniedError` is what the runtime throws.** The
  framework maps it to `403 PolicyDenied` with `reason` in
  the response body. We don't throw it ourselves — we just
  return a `PolicyDecision` and the framework handles the
  rest.

### Player.policy

Open `src/player.ts`. The Player class has handlers
`join`, `whoami`, `transitionThroughDoor`, `addItem`. The
first two are browser-facing (called via REST); the last two
are internal (called by Room and Merchant respectively).

```ts
export class Player extends Actor<PlayerState> {
  static policy(p: Principal, action: PolicyAction<PlayerState>): PolicyDecision {
    if (action.kind === 'read') {
      // GET /v1/actors/Player/<id> snapshot — only the player
      // themselves can read it. Other players seeing each other's
      // inventory or current room is leaky.
      if (action.actor.ref.id !== p.sub) {
        return { allow: false, reason: 'cannot read another player' };
      }
      return 'allow';
    }
    if (action.kind !== 'call') return 'allow';

    // Owner-only: the calling principal must match the Player
    // actor's id.
    const ownerOnly = ['join', 'whoami'];
    if (ownerOnly.includes(action.method)) {
      if (action.actor.ref.id !== p.sub) {
        return { allow: false, reason: `${action.method}: not your player` };
      }
    }

    // Internal handlers: called via cross-actor `tell` or `call`
    // from inside the Room or Merchant. Any external call denied.
    const internalOnly = ['transitionThroughDoor', 'addItem'];
    if (internalOnly.includes(action.method)) {
      return { allow: false, reason: `${action.method}: internal handler` };
    }

    return 'allow';
  }

  // ... existing handlers ...
}
```

Note the new branch for `action.kind === 'read'`. This fires
for `GET /v1/actors/Player/<id>` (the snapshot route). The
`runtime.checkRead` call on the snapshot route runs the
policy with `kind: 'read'`. We use it to keep player state
private to the player.

### Merchant.policy

Edit `src/merchant.ts`:

```ts
export class Merchant extends Actor<MerchantState> {
  static policy(p: Principal, action: PolicyAction<MerchantState>): PolicyDecision {
    if (action.kind !== 'call') return 'allow';

    // The purchase handler is the headline gate. The buyer
    // principal must match the playerId in args.
    if (action.method === 'purchase') {
      const args = action.args as { playerId?: string };
      if (args.playerId !== p.sub) {
        return {
          allow: false,
          reason: `purchase: principal ${p.sub} cannot buy as ${args.playerId}`,
        };
      }
      return 'allow';
    }

    // appearIn / leave are called by the Dungeon via cross-actor
    // call (which bypasses policy). Anything reaching here is a
    // forged direct call.
    const internalOnly = ['appearIn', 'leave'];
    if (internalOnly.includes(action.method)) {
      return { allow: false, reason: `${action.method}: internal handler` };
    }

    // read passes through.
    return 'allow';
  }

  // ... existing handlers ...
}
```

### What about Dungeon?

`Dungeon` has `enter` (called by Player.join via cross-actor)
and `neighborOf` (called by Player.transitionThroughDoor via
cross-actor). Both are internal — cross-actor calls bypass
policy, so direct external POSTs are the only ones that hit
the policy gate.

For defense-in-depth, you _could_ add a `Dungeon.policy` that
denies everything except read. The tutorial skips this to
keep the chapter focused, but it's a one-method addition:

```ts
static policy(_p, action): PolicyDecision {
  if (action.kind === 'call') {
    return { allow: false, reason: 'all dungeon handlers are internal' };
  }
  return 'allow';
}
```

Adding this is a defense-in-depth call; the tutorial leaves it
out so as not to clutter the chapter.

## Run it

```bash
pnpm dev
```

Open the page. Everything should behave exactly as in
chapter 11 — your moves work, the buy button works, walking
through doors works. The auth + policy layer is invisible
when you're calling correctly.

Open a second private window. Different `localStorage`, so a
different `playerId`. Both browsers should function
independently.

### The forgery test

Now the deliverable. In browser A's developer console, find
browser B's player id (you can read it from `?id=...` on
their tab, or from the entity list rendered in browser A's
canvas — `latestRoomState.entities`). Then try to move browser
B's player from browser A:

```js
const victimId = '<player B's id>';
fetch('/v1/actors/Room/' + activeRoomId + '/move', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer ' + localStorage.getItem('actjs.playerId'),
  },
  body: JSON.stringify({ playerId: victimId, x: 1, y: 1 }),
}).then((r) => r.json()).then(console.log);
```

You should see:

```json
{
  "type": "https://actjs.dev/errors/PolicyDenied",
  "title": "PolicyDeniedError",
  "status": 403,
  "code": "PolicyDenied",
  "detail": "policy denied call move on Room: move: principal <A> cannot act as <B>",
  "reason": "move: principal <A> cannot act as <B>"
}
```

That's the deliverable. The policy denied the call before it
reached the handler; no state mutated, no patch broadcast. The
`reason` field is what the framework surfaced from your
`return { allow: false, reason: ... }`.

Try the same against `Merchant.Garrick.purchase`:

```js
fetch('/v1/actors/Merchant/Garrick/purchase', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer ' + localStorage.getItem('actjs.playerId'),
  },
  body: JSON.stringify({ playerId: '<player B id>', item: 'potion' }),
})
  .then((r) => r.json())
  .then(console.log);
```

Same `403 PolicyDenied`, different reason — buying potions on
behalf of another player.

Try a direct call to an internal handler:

```js
fetch('/v1/actors/Player/' + localStorage.getItem('actjs.playerId') + '/addItem', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer ' + localStorage.getItem('actjs.playerId'),
  },
  body: JSON.stringify({ item: 'free-sword' }),
})
  .then((r) => r.json())
  .then(console.log);
```

`403 PolicyDenied: addItem: internal handler`. Even calling it
on your own player is denied — addItem is meant for the merchant
to call after it's verified the trade. Direct callers can't
bypass that.

## What policy doesn't yet gate

Two important gaps to know about for production code:

- **WebSocket subscriptions.** Today
  `actor.subscribe(class, id)` doesn't run through the
  policy gate. A browser subscribed to another player's
  Player actor would observe their `currentRoomId` and
  `inventory` updates, even though `GET /v1/actors/Player/<id>`
  would be denied. This is a known framework gap; fixing it
  is an actjs-level change, not a tutorial-level one.
- **Cross-actor `call` / `tell`.** Deliberately bypasses
  policy (see "The two layers" above). The Merchant calling
  `Player.addItem` works because we trust the merchant. If
  you wanted defense-in-depth on cross-actor calls, you'd
  thread a principal through the bridge — currently it
  always carries the system principal for internal calls.

Both are documented framework decisions. The tutorial calls
them out so you're not surprised when you go looking.

## Commit + tag

```bash
git add .
git commit -m "ch12: BYO auth + per-actor policy() gates"
git tag ch12-done
```

## Recap

| Concept                              | Where it landed                            |
| ------------------------------------ | ------------------------------------------ |
| `auth(req)` hook                     | `src/server.ts` — Bearer reader + WS query |
| `Principal` on every request         | `req.principal` populated by the framework |
| `static policy(p, action)` per class | `Room`, `Player`, `Merchant`               |
| Owner check                          | `args.playerId === p.sub`                  |
| Internal-only handlers               | Deny in policy; system principal bypasses  |
| Default allow                        | Reads, internal-flow methods that bypass   |
| `PolicyDenied → 403` mapping         | Framework-side (Phase 7.1)                 |

What didn't change:

- The actor classes' handler logic (all the work happens in
  the static method).
- The browser's render loop, subscription logic, click
  handling.
- The wire protocol — same JSON-RPC + RFC 6902 patches.

The framework did 90% of the work this chapter. We wrote ~80
lines of policy code distributed across three actors and an
~10-line auth hook. The runtime fired the policy on every
boundary call, mapped denials to RFC 7807 responses, and
short-circuited for the system principal so the reminder
dispatcher's `tell` calls keep working.

## What's next

**Chapter 13 — Capability share link** uses the same
Principal machinery for a different use case: minting a
short-lived signed token that lets a friend spectate your
dungeon without an account. The auth hook gains a second
branch (recognize `Authorization: Capability <jwt>`); the
policy fires the same way.

After that, **chapter 14 — Reminders for monsters + AFK
timeouts** is finally the durable-reminder chapter the
tutorial's been pointing at, and **chapter 15 — Parties**
is the N-way collaborative write pattern from the
interlude.

---

## Troubleshooting

**Every request returns 403 even my own moves**

Your `Authorization: Bearer <playerId>` header isn't reaching
the server. Most likely cause: the bearer is being read from
`localStorage` before `getOrMintPlayer` runs. Reorder so the
player id is set before any `rpc(...)` call.

**WebSocket connects but no patches arrive**

The WS upgrade didn't pick up the token. Either you forgot
to append `?token=<playerId>` to the URL, or your auth hook
isn't reading the query string. Check the server logs for
"401" or principal mismatches on the upgrade.

**Anonymous users can still hit `/openapi.json` and `/v1/health`**

That's by design — those routes don't have policy gates.
`buildApp` registers them without an auth requirement; the
framework intentionally keeps health checks and OpenAPI
docs accessible.

**Policy denial says "principal anonymous cannot act as
<playerId>"**

Your bearer token didn't make it through the auth hook.
Verify that the Authorization header is exactly
`Bearer <playerId>` (single space, no extra quoting). Check
the Network panel's request headers.

**Two browsers in the same private window share auth**

`localStorage` is keyed by origin, not tab. Use two
genuinely separate browser sessions (a regular window and a
private window count as two; two tabs in the same window
don't).

**The merchant denies my own player's purchase**

You probably sent `playerId` as a string but the bearer is
something different (e.g., a truncated id). Check both are
the full UUIDv7 from `localStorage.actjs.playerId`.

**`PolicyDeniedError` is thrown but not caught by my code**

The framework catches it and maps to a 403 response. You see
the rejection on the client (the `rpc` helper throws on
non-2xx). If you're seeing an uncaught exception in the
server logs, check that `src/server/errors.ts` is wired
into `buildApp` (it should be by default; if you've forked
the error handler, the `PolicyDeniedError` mapping might be
missing).
