# Chapter 06 — Subscriptions: stop polling

> **Chapter goal:** drop the polling loop. The browser opens one
> WebSocket, subscribes to the room, receives the initial snapshot,
> and applies RFC 6902 patches as the server emits them. Two
> browser tabs subscribed to the same room see each other's
> updates immediately.
>
> **Time budget:** ~60 minutes.
>
> **End-of-chapter tag:** `ch06-done`.

---

Chapter 05 ended with the renderer doing the worst possible thing
on a hot network path: re-fetching the whole room every 200 ms
while anything was animating. This chapter replaces that with
the right shape — server-pushed RFC 6902 patches over a single
WebSocket — and does it without touching the server.

The actjs lesson: **subscriptions are server-side state, not
client-side state.** When a handler mutates `this.state`, the
runtime computes the diff against the prior state, picks every
attached subscriber out of the registry, and pushes the patch.
The room actor doesn't know who's subscribed; it doesn't even
know subscribers exist. The wiring is in `buildApp`, the patches
are produced by the framework, and the client's job is to keep
a local mirror of the state up to date.

By the end of this chapter you will:

- Have a single WebSocket per browser tab.
- Have a ~35-line subset of an RFC 6902 patch applier, doing
  the work a JSON Patch library would.
- Have a `WsClient` class wrapping the JSON-RPC framing
  required to subscribe and dispatch notifications.
- Have replaced the chapter 05 polling loop with a subscription
  callback that re-renders on push.
- Have the deliverable: two browser tabs both subscribed to the
  same room, both seeing tick updates at the same time.

## What you're going to see on the wire

Before any code, let's name the protocol. The WebSocket
endpoint actjs exposes at `/v1/ws` speaks **JSON-RPC 2.0** in
both directions. The client sends requests; the server sends
responses to those requests _and_ unsolicited notifications.

A subscribe request looks like this:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "actor.subscribe",
  "params": { "class": "Room", "id": "019e4d5e-1111-..." }
}
```

The server responds in-band with the subscriptionId:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { "subscriptionId": "sub-abc123" }
}
```

And then — **immediately, before the response above is even
flushed to the wire** — it pushes the initial snapshot as a
notification (no `id` field):

```json
{
  "jsonrpc": "2.0",
  "method": "actor.event",
  "params": {
    "subscriptionId": "sub-abc123",
    "kind": "snapshot",
    "data": { "width": 20, "height": 20, "tiles": [...], "entities": [...], ... }
  }
}
```

From then on, every time the room's state changes (e.g. the
tick handler advances the player one tile), the server pushes a
patch:

```json
{
  "jsonrpc": "2.0",
  "method": "actor.event",
  "params": {
    "subscriptionId": "sub-abc123",
    "kind": "patch",
    "patch": [
      { "op": "replace", "path": "/entities/0/x", "value": 6 },
      { "op": "replace", "path": "/entities/0/y", "value": 4 },
      { "op": "remove", "path": "/entities/0/path/0" }
    ]
  }
}
```

The patches are diffs between the old `state` and the new
`state` after the handler returned. The framework computes them
for free.

That's the whole protocol our chapter needs. (`kind` can also
be `'event'` for event-sourced actors — chapter 16 — or
`'tombstone'` when the actor is deleted. We won't see either
here.)

## A minimal JSON Patch applier

RFC 6902 patches are JSON arrays of operations. Each op has an
`op` (`add` / `replace` / `remove` / `move` / `copy` / `test`)
and a `path` written as an RFC 6901 JSON Pointer (e.g.
`/entities/0/x`). actjs's SWM patches use only `add`, `replace`,
and `remove`, which we can implement in about 30 lines.

> **The actjs SDK does this for you.** `@jplevyak/actjs/client` ships a
> `Client` class that handles the WebSocket, the JSON-RPC
> framing, patch application, reconnection, optimistic updates,
> and offline queueing in one package. We hand-roll here so you
> see what the wire actually carries. In production code,
> `import { Client } from '@jplevyak/actjs/client'` and the entire
> contents of this chapter collapses to four lines.

Create `public/json-patch.js`:

```js
/**
 * Minimal RFC 6902 patch applier — `add`, `replace`, `remove`
 * only, the three operations actjs's SWM patches use. Paths are
 * RFC 6901 JSON Pointers; `~0` decodes to `~` and `~1` decodes
 * to `/`.
 *
 * Returns the new state; never mutates the input.
 */
export function applyPatch(state, ops) {
  let result = structuredClone(state);
  for (const op of ops) {
    const path = parsePointer(op.path);
    if (path.length === 0) {
      // Whole-document replacement (path is "").
      if (op.op === 'add' || op.op === 'replace') result = op.value;
      continue;
    }
    let parent = result;
    for (let i = 0; i < path.length - 1; i++) {
      const seg = Array.isArray(parent) ? Number(path[i]) : path[i];
      parent = parent[seg];
    }
    const last = path[path.length - 1];
    const idx = Array.isArray(parent) ? Number(last) : last;
    if (op.op === 'add') {
      if (Array.isArray(parent)) parent.splice(idx, 0, op.value);
      else parent[idx] = op.value;
    } else if (op.op === 'replace') {
      parent[idx] = op.value;
    } else if (op.op === 'remove') {
      if (Array.isArray(parent)) parent.splice(idx, 1);
      else delete parent[idx];
    }
    // (move/copy/test omitted — actjs SWM patches don't emit them.)
  }
  return result;
}

function parsePointer(p) {
  if (p === '') return [];
  if (p[0] !== '/') throw new Error(`invalid JSON pointer: ${p}`);
  return p
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}
```

Two notes:

- **`structuredClone`** is a structured-clone built-in in modern
  browsers. It deep-copies the state so we never mutate the
  reference we previously rendered. For a 400-tile room with a
  handful of entities, this is microseconds.
- **`add` on an array inserts at `idx`; `add` on an object
  assigns the key.** RFC 6902 says so; the chapter 05 entities
  array gets array `add` ops when the room spawns a new
  entity. (We don't see that yet — single player — but
  chapter 11 will.)

## The WebSocket client

Now the WS-and-JSON-RPC plumbing. Create `public/ws-client.js`:

```js
import { applyPatch } from './json-patch.js';

/**
 * Single-WebSocket multiplexed JSON-RPC client.
 *
 * - One socket per page (the actjs SDK's `Client` does the same).
 * - `rpc(method, params)` returns a Promise that resolves with the
 *   server's `result` (or rejects with the server's `error`).
 * - `subscribe(class, id, onState)` returns an unsubscribe
 *   function. The callback fires immediately with the initial
 *   snapshot, then on every patch the server pushes.
 */
export class WsClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map(); // request id → {resolve, reject}
    this.subscribers = new Map(); // subscriptionId → listener
    this.states = new Map(); // subscriptionId → current state
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('WebSocket error')));
      this.ws.addEventListener('message', (e) => this.#handle(JSON.parse(e.data)));
      this.ws.addEventListener('close', () => {
        // Production code (the actjs SDK) reconnects with backoff
        // here and re-subscribes from the last seen seq. For the
        // tutorial we'll just surface the close.
        console.warn('WS closed; reload to reconnect');
      });
    });
  }

  rpc(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  async subscribe(className, actorId, onState) {
    const { subscriptionId } = await this.rpc('actor.subscribe', {
      class: className,
      id: actorId,
    });
    this.subscribers.set(subscriptionId, onState);
    return async () => {
      this.subscribers.delete(subscriptionId);
      this.states.delete(subscriptionId);
      await this.rpc('actor.unsubscribe', { subscriptionId });
    };
  }

  #handle(msg) {
    // Response to a prior request.
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    // Notification.
    if (msg.method !== 'actor.event') return;
    const { subscriptionId, kind, data, patch } = msg.params;
    let state = this.states.get(subscriptionId);
    if (kind === 'snapshot') {
      state = data;
    } else if (kind === 'patch') {
      state = applyPatch(state, patch);
    } else {
      // 'event' (ES) and 'tombstone' — not used in chapter 06.
      return;
    }
    this.states.set(subscriptionId, state);
    const listener = this.subscribers.get(subscriptionId);
    if (listener) listener(state);
  }
}
```

Three pieces are worth pausing on:

- **One socket, multiplexed.** The same `ws` carries every
  request and every notification. We tag requests with
  monotonic ids (`this.nextId++`) so we can match responses
  back to the right promise; notifications carry a
  `subscriptionId` so we can route them to the right listener.
  Multiplexing is what makes "100 actor subscriptions per page"
  cheap.
- **`subscribe` returns an unsubscribe function.** Idiomatic for
  any pub/sub API and lets the caller scope subscriptions to a
  component's lifetime. The `@jplevyak/actjs/bindings/react` and `@jplevyak/actjs/bindings/svelte`
  bindings call this dance for you when a component mounts /
  unmounts.
- **Reconnection is omitted.** Production code (the actjs SDK)
  reconnects with exponential backoff and replays subscriptions
  from the last seen seq. Our chapter just warns and tells the
  reader to reload. If you kill the server and bring it back,
  the page won't recover — but in chapter 18 with the PG
  driver, hitting reload from a fresh page works because the
  room snapshot is durable.

## Update `public/main.js`

The renderer code (the `render(canvas, room)` function) doesn't
change. The plumbing around it does: we drop the polling
machinery and add the subscription.

```js
import { WsClient } from './ws-client.js';

const TILE = 24;

const TILE_STYLES = {
  '#': { color: '#3a3a3a', glyph: '' },
  '.': { color: '#161616', glyph: '' },
  '+': { color: '#a87a25', glyph: '+' },
};
const UNKNOWN_TILE = { color: '#ff00ff', glyph: '?' };

const ENTITY_STYLES = {
  player: { glyph: '@', color: '#fff' },
};
const UNKNOWN_ENTITY = { glyph: '?', color: '#f0f' };

async function rpc(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

const mintRoom = () => rpc('/v1/actors/Room').then((r) => r.id);
const moveTo = (id, x, y) => rpc(`/v1/actors/Room/${id}/move`, { x, y });

function render(canvas, room) {
  canvas.width = room.width * TILE;
  canvas.height = room.height * TILE;
  const ctx = canvas.getContext('2d');
  ctx.font = `${Math.floor(TILE * 0.7)}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let y = 0; y < room.height; y++) {
    const row = room.tiles[y];
    for (let x = 0; x < room.width; x++) {
      const style = TILE_STYLES[row[x]] ?? UNKNOWN_TILE;
      ctx.fillStyle = style.color;
      ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
      if (style.glyph) {
        ctx.fillStyle = '#fff';
        ctx.fillText(style.glyph, x * TILE + TILE / 2, y * TILE + TILE / 2);
      }
    }
  }
  for (const e of room.entities) {
    const style = ENTITY_STYLES[e.id] ?? UNKNOWN_ENTITY;
    ctx.fillStyle = style.color;
    ctx.fillText(style.glyph, e.x * TILE + TILE / 2, e.y * TILE + TILE / 2);
  }
}

async function main() {
  const params = new URLSearchParams(location.search);
  let id = params.get('id');
  if (!id) {
    id = await mintRoom();
    history.replaceState(null, '', `?id=${id}`);
  }
  document.getElementById('roomId').textContent = id;

  const canvas = document.getElementById('dungeon');
  const wsUrl = `${location.origin.replace(/^http/, 'ws')}/v1/ws`;
  const client = new WsClient(wsUrl);
  await client.connect();

  // Subscribe. The first call to `render` happens inside this
  // subscription (on the initial snapshot), and every subsequent
  // call happens on each patch the server pushes.
  await client.subscribe('Room', id, (state) => render(canvas, state));

  canvas.addEventListener('click', async (event) => {
    const rect = canvas.getBoundingClientRect();
    const tx = Math.floor((event.clientX - rect.left) / TILE);
    const ty = Math.floor((event.clientY - rect.top) / TILE);
    await moveTo(id, tx, ty);
    // No polling! The subscription handles all subsequent renders.
  });
}

main().catch((err) => {
  document.body.innerHTML = `<pre style="color:#f55;padding:1rem">${err.stack}</pre>`;
});
```

What disappeared from chapter 05:

- **`POLL_MS`** — gone. We're event-driven now.
- **`pollHandle` + `setInterval` + `clearInterval`** — gone.
- **`readRoom` and `startPollingUntilStill`** — gone. The initial
  state arrives via the subscription's snapshot; subsequent
  state arrives via patches.
- **The `const room = await readRoom(id); render(canvas, room);`
  bootstrap** — gone. The subscription handler renders the
  initial snapshot.

What's new:

- **Import map–style ES module imports.** `main.js` imports
  `./ws-client.js`, which in turn imports `./json-patch.js`.
  Browser-native ES modules; no bundler.
- **`location.origin.replace(/^http/, 'ws')`** maps `http://` to
  `ws://` and `https://` to `wss://` in one line. The server's
  WS endpoint is on the same origin as the HTTP server, so we
  don't need any cross-origin dance.

The `index.html` doesn't need to change — `<script type="module"
src="/main.js">` already supports the import-chain.

## Run it

```bash
pnpm dev
```

Open `http://localhost:3000/` in two browser tabs (side by side,
or two windows). Both should converge to the same dungeon
because they share the `?id=...` URL — paste the URL from tab
1's address bar into tab 2 if you minted them separately.

Click somewhere in tab 1. **The player moves in both tabs
simultaneously, no polling delay.** That's the deliverable.

Try a few:

- **Click in tab 2.** The player path changes; both tabs
  reflect the new path within one tick.
- **Click on a wall in either tab.** Nothing happens (handler
  returns `pathLength: 0`); no patch is emitted because state
  didn't change.
- **Click rapidly.** Each click replaces the path; the next
  patch reflects the latest target. Tabs stay in sync because
  they're observing the same authoritative state.

## Inspect the wire

Open the browser's Network panel. Filter for WS. Click the
`/v1/ws` connection and look at the **Messages** tab. You'll
see:

| Direction | Frame                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------- |
| ↑         | `{"jsonrpc":"2.0","id":1,"method":"actor.subscribe","params":{"class":"Room","id":"..."}}`        |
| ↓         | `{"jsonrpc":"2.0","id":1,"result":{"subscriptionId":"..."}}`                                      |
| ↓         | `{"jsonrpc":"2.0","method":"actor.event","params":{"subscriptionId":"...","kind":"snapshot",...}` |

After clicking, you'll see patch frames flow:

```
↓ {"jsonrpc":"2.0","method":"actor.event","params":{
    "subscriptionId":"...","kind":"patch",
    "patch":[{"op":"replace","path":"/entities/0/x","value":6},...]
  }}
```

The frames you'll see are typically 80–150 bytes for a one-tile
move, plus negligible WS framing overhead. Compare to chapter
05: each `read` POST was returning the full room snapshot
(~600–900 bytes of JSON, plus HTTP request/response framing).
And we're no longer paying the 200 ms client-side timer; the
server pushes the moment state changes.

## What didn't move (the chapter's main point)

**The server.** Not one line. `runtime.register({name:'Room', ctor:Room})`
in chapter 02 lit up subscriptions just like it lit up REST and
the rest of the routes. `Room.tick` mutates `this.state` and
the framework computes the patches; the framework discovers
who's subscribed via the `SubscriptionRegistry` that `buildApp`
wired in; the framework writes the WebSocket frames.

The room actor doesn't import the subscription registry. It
doesn't know subscribers exist. The "every state change is
broadcast to subscribers" rule is a property of the
framework, not of any actor code.

That's the lesson: **broadcasts are free.** If you'd already
shipped chapter 02's `Room` exactly as written, with no
subscription-aware code in the actor, you'd have the same
broadcasts arriving in your browser tonight by writing only
chapter 06's client code. The actor doesn't change shape as
the audience grows.

## Same chapter, with the SDK

Now that you've seen the wire protocol, you've earned the
SDK. `@jplevyak/actjs/client` collapses the WS client, the
JSON Patch applier, and the subscription registry into one
import — _plus_ everything we deliberately skipped:
reconnection with exponential backoff, replay-on-reconnect
using `lastSeq`, optimistic updates via Immer, an offline
mutation queue keyed by `Idempotency-Key`, and codegen-typed
`call` proxies (arriving in a later chapter).

This section is the drop-in swap. The hand-roll above is still
worth having walked through — it's what the SDK does. But for
real code, you'd write the SDK version instead.

### Cost: pick one of three browser-side strategies

The SDK runs in the browser via standard ES-module imports, but
its bare specifiers (`immer`, `fast-json-patch`) need to resolve
somehow. Three options:

1. **Native import maps** (what this section uses). Add a
   `<script type="importmap">` block to `index.html` plus a
   second `@fastify/static` registration mounting
   `node_modules` at `/vendor`. ~15 lines total; no build step;
   "no build step" promise from chapter 01 intact.
2. **A bundler** (Vite, esbuild, Rollup). Adds one dev dep and
   a build step. Lower friction at scale, higher friction in
   this tutorial's no-bundler trajectory.
3. **A CDN** (esm.sh, jsdelivr). Once `@jplevyak/actjs` is
   published, `import { Client } from 'https://esm.sh/@jplevyak/actjs/client'`
   "just works" without any local plumbing. Adds a hard runtime
   dependency on the CDN's uptime.

This section goes with **option 1** because the tutorial
already speaks `@fastify/static` and `index.html`. The CDN
path is a one-line swap once `@jplevyak/actjs` is live on npm.

### Server change: mount `node_modules` at `/vendor`

Open `src/server.ts`. After the existing static-plugin
registration, add a second one:

```ts
// First registration (existing): serve `public/` at `/`.
await app.register(fastifyStatic, {
  root: join(here, '..', 'public'),
  prefix: '/',
});

// Second registration: serve `node_modules/` at `/vendor`.
// The import map in `public/index.html` resolves bare
// specifiers (e.g. 'immer') to URLs under `/vendor/`.
await app.register(fastifyStatic, {
  root: join(here, '..', 'node_modules'),
  prefix: '/vendor/',
  decorateReply: false, // already decorated by the first registration
});
```

The `decorateReply: false` flag is required — Fastify's static
plugin decorates `reply.sendFile` once per process; the second
registration must opt out of that decoration.

### Browser change: import map in `index.html`

Add this `<script type="importmap">` block to `public/index.html`
**before** the existing `<script type="module" src="/main.js">`
line:

```html
<script type="importmap">
  {
    "imports": {
      "@jplevyak/actjs/client": "/vendor/@jplevyak/actjs/dist/client/index.js",
      "immer": "/vendor/immer/dist/immer.legacy-esm.js",
      "fast-json-patch": "/vendor/fast-json-patch/index.mjs"
    }
  }
</script>
<script type="module" src="/main.js"></script>
```

Three entries: one for the SDK itself, two for its bare-specifier
runtime dependencies. The browser fetches each through the
static-vendor mount; internal relative imports inside each
package resolve naturally from there.

### Browser change: swap `main.js` for the SDK

Replace `public/main.js` with the SDK version. The renderer
function (~30 lines) doesn't change; the plumbing around it
becomes:

```js
import { Client } from '@jplevyak/actjs/client';

const TILE = 24;

const TILE_STYLES = {
  '#': { color: '#3a3a3a', glyph: '' },
  '.': { color: '#161616', glyph: '' },
  '+': { color: '#a87a25', glyph: '+' },
};
const UNKNOWN_TILE = { color: '#ff00ff', glyph: '?' };

const ENTITY_STYLES = {
  player: { glyph: '@', color: '#fff' },
};
const UNKNOWN_ENTITY = { glyph: '?', color: '#f0f' };

function render(canvas, room) {
  // ... same body as the hand-roll version above ...
}

async function rpc(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const params = new URLSearchParams(location.search);
  let id = params.get('id');
  if (!id) {
    id = (await rpc('/v1/actors/Room')).id;
    history.replaceState(null, '', `?id=${id}`);
  }
  document.getElementById('roomId').textContent = id;

  const canvas = document.getElementById('dungeon');

  // One Client per page. The SDK opens the WebSocket, handles
  // reconnection + backoff + subscription replay, and gives us
  // a typed actor handle.
  const client = new Client({ url: location.origin });
  const room = client.actor('Room', id);

  // Subscribe: the listener fires with the initial snapshot,
  // then with each new state after the SDK applies the inbound
  // patch. Returns an unsubscribe function we'd call on cleanup.
  await room.subscribe((state) => render(canvas, state));

  canvas.addEventListener('click', async (event) => {
    const rect = canvas.getBoundingClientRect();
    const tx = Math.floor((event.clientX - rect.left) / TILE);
    const ty = Math.floor((event.clientY - rect.top) / TILE);
    // `room.call.move` is duck-typed at runtime; codegen
    // (later chapter) makes it compile-time-typed too.
    await room.call.move({ x: tx, y: ty });
  });
}

main().catch((err) => {
  document.body.innerHTML = `<pre style="color:#f55;padding:1rem">${err.stack}</pre>`;
});
```

What disappeared:

- `public/ws-client.js` — the `Client` class replaces it.
- `public/json-patch.js` — the SDK applies patches internally.
- The `wsUrl` derivation — the SDK derives the WS URL from
  `url`.
- The reconnect-was-omitted disclaimer — the SDK handles
  reconnect with exponential backoff.

What didn't change:

- The renderer.
- The room actor or any server code.
- The wire protocol — open the Network panel and you'll see
  the same `actor.subscribe` request and `actor.event`
  notifications the hand-roll handled. The SDK is doing the
  same work; it just doesn't make you write it.

### What you got for the swap

Comparing the SDK version to the hand-roll above:

| Capability                                | Hand-roll | SDK |
| ----------------------------------------- | --------- | --- |
| Subscribe + receive snapshot              | ✓         | ✓   |
| Apply RFC 6902 patches                    | ✓         | ✓   |
| Multiplex many subscriptions per socket   | ✓         | ✓   |
| Reconnect with backoff                    | —         | ✓   |
| Re-subscribe on reconnect using `lastSeq` | —         | ✓   |
| Optimistic updates via Immer              | —         | ✓   |
| Offline mutation queue                    | —         | ✓   |
| Idempotency-Key on every call             | —         | ✓   |
| Codegen-typed `call.<method>` proxies     | —         | ✓   |
| Per-actor handle (`client.actor(...)`)    | —         | ✓   |
| Lines of code in `public/`                | ~100      | ~5  |

The hand-roll told you what the protocol carries; the SDK gives
you the production envelope around it. Later chapters continue
using the hand-roll for consistency with the chapter-06 spine —
swap to the SDK in your own copy if you'd rather, every
chapter's deliverable works the same either way.

### Try it

```bash
pnpm dev
```

Open two browser tabs (or two private windows) on the same
`?id=...` URL. Click in one; watch the player walk in both.
Behavior should be identical to the hand-roll version above.
The wire frames in the Network panel should be identical too —
that's the proof that the SDK is doing the same protocol work,
not a different one.

## Commit + tag

```bash
git add .
git commit -m "ch06: WS subscriptions; drop polling"
git tag ch06-done
```

## Recap

| New artifact               | Lines | Purpose                                          |
| -------------------------- | ----- | ------------------------------------------------ |
| `public/json-patch.js`     | ~30   | RFC 6902 `add` / `replace` / `remove` applier.   |
| `public/ws-client.js`      | ~50   | JSON-RPC framing over WS, subscription dispatch. |
| `public/main.js` (rewrite) | (–20) | Subscription replaces polling.                   |

What stayed the same:

- **The server.** All zero lines of it.
- **`Room`** — the actor code from chapter 05 is byte-identical.
- **`render(canvas, room)`** — the renderer doesn't know
  whether its input came from a `POST /read` or a WS patch.
  Same data, same code.

The framework's promise is that subscriptions are an emergent
property of registering a class. You don't opt in; you don't
declare subscribers; you don't wire a publish path. State
changes broadcast.

## What's next

**Chapter 07 — Player actor** introduces the second actor class
in the dungeon: `Player`. Each browser session minds its own
player; the room actor coordinates entities from multiple
player actors via cross-actor `call` from inside the room
(`this.actjs.call(player, 'currentPosition')` or similar).
This is where the actor model starts paying off — the
single-room-with-one-player shape from chapters 02–06 is the
warm-up.

---

## Troubleshooting

**WS connects but no snapshot arrives**

The first thing the server pushes on subscribe is the
snapshot — and it does so synchronously inside the
`actor.subscribe` handler, before the JSON-RPC response is
flushed. If your code awaits the response first and _then_
registers the listener, the snapshot can race ahead of you.
Our `WsClient.subscribe` registers the listener after
`rpc(...)` resolves, which works in practice because the
server sends both frames over the same socket in order; the
production SDK splits registration earlier to be safer.

**Patches arrive but state is wrong**

Look at the Network panel's WS messages and compare the
patch's `path` to your state shape. The most common mistake is
a stale `?id=` in the URL from an earlier chapter's run — the
room's state shape grew between chapters, so a chapter-03
snapshot won't apply chapter-06 patches cleanly. Click the
"fresh dungeon" link in the header.

**WS closes immediately on connect**

Make sure the server is on the same origin as `/main.js`.
`location.origin.replace(/^http/, 'ws')` produces `ws://...`
or `wss://...` matching the page; if you opened the page over
`file://`, the regex will fail and the URL ends up wrong.
Always serve the page from the actjs server (`http://localhost:3000`),
never open `index.html` directly.

**Two tabs show different cursors / desync**

Both tabs receive the same patch stream in the same order;
true desync shouldn't happen. If you see it, check whether
one tab is on an old `?id=` URL — they'd be subscribed to
different rooms. They look similar (drunkard's walk over
random ids), but the entities are different.

**`structuredClone is not a function`**

You're on a very old browser (Firefox < 94, Chrome < 98).
Either upgrade or polyfill: `state = JSON.parse(JSON.stringify(state))`
is a slow-but-functional replacement for our use case.

**A handler returns a value; where does it show up over WS?**

`actor.call` works over WebSocket too: send
`{method: 'actor.call', params: {class, id, method, args}}`
and the response carries `result`. The chapter doesn't use
that path because the click → `POST /move` flow is shorter
to explain. The SDK does both via the same socket.
