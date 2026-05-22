# Chapter 07 — Player actor

> **Chapter goal:** introduce a second actor class — `Player` —
> with its own durable identity and inventory slot. The browser
> remembers its player id across reloads; the room hosts one
> entity per logged-in player; cross-actor `this.actjs.call(...)`
> wires the join flow.
>
> **Time budget:** ~60 minutes.
>
> **End-of-chapter tag:** `ch07-done`.

---

Six chapters in, the room actor is doing all the work — tile
grid, entities, ticks, broadcasts. That's been fine for one
hardcoded `'player'`, but two browser tabs sharing a single `@`
doesn't feel like a multiplayer game. This chapter splits the
responsibilities the way they want to be split: **the room owns
the space; the player owns themselves.**

The actjs lesson: a second actor class is essentially free.
`runtime.register(Player, ...)` lights up the REST + WS routes
for it, just like `runtime.register(Room, ...)` did in
chapter 02. The interesting question is how the two actors
coordinate — and the answer is `this.actjs.call(ref, ...)`,
the in-process cross-actor RPC. From inside a handler, you can
call another actor; the framework routes the call through the
target actor's mailbox so the SWM guarantees still hold.

By the end of this chapter you will:

- Have a `Player` actor class that owns `displayName`,
  `currentRoomId`, and an empty `inventory` slot (chapter 10
  fills it).
- Have learned the `ActorRef` shape and the
  `this.actjs.call(ref, method, args)` cross-actor pattern.
- Have a `Player.join({roomId})` handler that calls into the
  target room to add an entity. The browser hits `join`; the
  player calls the room; the room broadcasts the spawn to every
  subscriber.
- Have replaced the hardcoded `'player'` entity in the room
  with one entity per joined player, each with its own
  hash-derived color.
- Have the deliverable: open the page in two private/incognito
  windows, each gets its own player id (via localStorage),
  both join the same room, both `@` glyphs walk independently.

## Why a separate actor

You could keep the player as a record inside `Room.state.entities`
forever. The reasons not to:

- **Durable per-player state outlives the room.** When chapter 08
  adds room-to-room transitions, the player needs to carry
  identity, inventory, and stats from one room to the next. A
  record inside one room actor can't.
- **Cross-room queries.** Chapter 10 wants a merchant whose
  inventory is shared across rooms. The natural pattern there
  is "the room asks the merchant" — i.e. one actor calls another.
  We'll exercise the same primitive here for the simpler
  `Player.join` case.
- **Authorization.** Chapter 11 wires `Principal` + `static
policy()` so a player can only move their own character. The
  policy check needs to be able to say "this Principal owns this
  Player actor," and the Player actor is the natural owner of
  that fact.
- **Each player gets its own mailbox.** Two players calling
  handlers at the same time are processed independently — no
  serial bottleneck through a single room actor for everything.

The cost of a separate actor: one extra mailbox turn per
operation that crosses the boundary. For the join flow that's
one cross-actor call (`Player → Room`). Cheap; the SWM
guarantees we get in exchange are valuable.

## Define the Player class

Create `src/player.ts`:

```ts
import { Actor } from '@jplevyak/actjs/actor';
import { handler } from '@jplevyak/actjs/handler';
import type { ActorRef } from '@jplevyak/actjs/types';
import { asActorId, asClassName, asVersion } from '@jplevyak/actjs/types';

export interface PlayerState {
  /** Friendly label shown in the UI. Derived from `actor_id` for now. */
  displayName: string;
  /** Where the player currently is. `null` if they haven't joined a room. */
  currentRoomId: string | null;
  /** Future-chapter slot. Empty in chapter 07. */
  inventory: unknown[];
}

export class Player extends Actor<PlayerState> {
  override onInit(): void {
    const id = this.actor_id as string;
    this.state = {
      displayName: `Player-${id.slice(-4)}`,
      currentRoomId: null,
      inventory: [],
    };
  }

  /**
   * Enter `roomId`. Updates this player's `currentRoomId` and
   * tells the target room to spawn an entity for us. Returns
   * the player's new identity payload so the browser can render
   * the welcome screen.
   */
  @handler('join')
  async join(args: { roomId: string }): Promise<{
    displayName: string;
    roomId: string;
  }> {
    this.state.currentRoomId = args.roomId;
    const room: ActorRef = {
      class: asClassName('Room'),
      id: asActorId(args.roomId),
      version: asVersion('1.0.0'),
    };
    await this.actjs!.call(room, 'addEntity', {
      playerId: this.actor_id as string,
      displayName: this.state.displayName,
    });
    return { displayName: this.state.displayName, roomId: args.roomId };
  }

  /** Read-only handler. The browser uses this on reload to confirm identity. */
  @handler('whoami')
  whoami(): { id: string; displayName: string; currentRoomId: string | null } {
    return {
      id: this.actor_id as string,
      displayName: this.state.displayName,
      currentRoomId: this.state.currentRoomId,
    };
  }
}
```

Three pieces to call out:

- **The state shape is small.** A name, the current room id, an
  inventory slot. We don't store `(x, y)` on the player — that
  lives in `Room.state.entities` because position is a
  property of being-in-a-room. When the player leaves a room
  (chapter 08) the position evaporates; when they enter a new
  one, the new room assigns a fresh position. `currentRoomId`
  is the player's canonical "where am I?".
- **`ActorRef`** is `{class, id, version}` — three branded
  values. The version is informational for in-process v1; the
  runtime resolves by class + id. We're calling
  `asClassName('Room')` and friends to satisfy the type system;
  v2 codegen will likely produce these as constants.
- **`this.actjs!.call(ref, 'addEntity', args)`** is the
  cross-actor RPC. The `!` is because TypeScript can't prove
  `this.actjs` is populated at this point (it's set by the
  runtime on activation, before `onInit` runs); in practice
  it's always defined inside a handler. Awaiting the call means
  this player's `join` doesn't return until the room has
  processed the spawn — by which point the room has emitted a
  subscription patch and any subscriber has rendered the new
  entity.

## How `this.actjs.call` routes

The in-process call goes through the same Directory + mailbox
pipeline as a wire-side `POST /v1/actors/Room/<id>/addEntity`:

```
Player handler
   └─ this.actjs!.call(roomRef, 'addEntity', args)
        └─ Directory.resolve(roomRef.id, roomRef.class)   ← materializes Room if cold
             └─ Room.mailbox.enqueue({ kind: 'call', method: 'addEntity', args })
                  └─ Room.addEntity runs in its own mailbox turn
                       └─ Room.state.entities.push(...)   ← state changes
                       └─ Framework computes patch + broadcasts
                  └─ Returns spawn payload to the awaiting Player
```

Three properties worth noting:

- **The Player handler awaits the Room turn.** Cross-actor
  `call` is request/response; `tell` is fire-and-forget. The
  join flow needs response semantics ("did the spawn
  succeed?"), so `call`. If you used `tell` the browser would
  see the player joined before the room finished spawning.
- **The room's broadcast happens whether the Player is awaiting
  or not.** Subscribers (browser tabs) see the new entity at the
  moment `Room.addEntity` mutates state; the Player's `await`
  is independent of the broadcast plane.
- **Two players joining at the same time serialize naturally.**
  Player A's call to `Room.addEntity` and Player B's call
  arrive in the room's mailbox; the mailbox processes them one
  at a time. Both spawn cleanly; both broadcasts go out. No
  application-level locking required, by construction.

## Update the Room

The room loses its hardcoded `'player'` entity and gains an
`addEntity` handler. Edit `src/room.ts`:

```ts
import { Actor } from '@jplevyak/actjs/actor';
import { handler } from '@jplevyak/actjs/handler';

import { findPath, isPassable, type Point } from './pathfinding.js';
import { drunkardsWalk } from './procgen.js';
import { hashStringToSeed } from './rng.js';

const WIDTH = 20;
const HEIGHT = 20;
const TICK_MS = 200;

export interface Entity {
  /** Player actor id (matches `Player.actor_id`). */
  id: string;
  /** Friendly label echoed from the Player actor on join. */
  displayName: string;
  x: number;
  y: number;
  path: Point[];
}

export interface RoomState {
  width: number;
  height: number;
  seed: number;
  tiles: string[];
  entities: Entity[];
  /** Computed once in `onInit`; every joining entity spawns here. */
  spawn: Point;
  tickScheduled: boolean;
}

export class Room extends Actor<RoomState> {
  override onInit(): void {
    const seed = hashStringToSeed(this.actor_id as string);
    const tiles = drunkardsWalk({ width: WIDTH, height: HEIGHT, seed });
    const spawn = findFirstFloor(tiles);
    this.state = {
      width: WIDTH,
      height: HEIGHT,
      seed,
      tiles,
      entities: [],
      spawn,
      tickScheduled: false,
    };
  }

  @handler('read')
  read(): RoomState {
    return this.state;
  }

  /**
   * Add a player entity to this room. Idempotent: if `playerId`
   * is already present, just return their current position.
   */
  @handler('addEntity')
  addEntity(args: { playerId: string; displayName: string }): { x: number; y: number } {
    const existing = this.state.entities.find((e) => e.id === args.playerId);
    if (existing) return { x: existing.x, y: existing.y };
    this.state.entities.push({
      id: args.playerId,
      displayName: args.displayName,
      x: this.state.spawn.x,
      y: this.state.spawn.y,
      path: [],
    });
    return { x: this.state.spawn.x, y: this.state.spawn.y };
  }

  /**
   * Move the named player. Replaces any existing path; ensures
   * the tick loop is running.
   */
  @handler('move')
  async move(args: { playerId: string; x: number; y: number }): Promise<{ pathLength: number }> {
    const entity = this.state.entities.find((e) => e.id === args.playerId);
    if (!entity) throw new Error(`player ${args.playerId} is not in this room`);
    const grid = {
      width: this.state.width,
      height: this.state.height,
      tiles: this.state.tiles,
    };
    if (!isPassable(grid, { x: args.x, y: args.y })) {
      entity.path = [];
      return { pathLength: 0 };
    }
    entity.path = findPath(grid, { x: entity.x, y: entity.y }, { x: args.x, y: args.y });
    if (entity.path.length > 0) await this.ensureTickRunning();
    return { pathLength: entity.path.length };
  }

  @handler('tick')
  async tick(): Promise<void> {
    this.state.tickScheduled = false;
    let anyMoving = false;
    for (const e of this.state.entities) {
      const next = e.path.shift();
      if (next) {
        e.x = next.x;
        e.y = next.y;
      }
      if (e.path.length > 0) anyMoving = true;
    }
    if (anyMoving) await this.ensureTickRunning();
  }

  private async ensureTickRunning(): Promise<void> {
    if (this.state.tickScheduled) return;
    this.state.tickScheduled = true;
    await this.actjs!.scheduleAt(this.actjs!.now() + TICK_MS, 'tick', {});
  }
}

function findFirstFloor(tiles: readonly string[]): Point {
  for (let y = 0; y < tiles.length; y++) {
    const row = tiles[y]!;
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '.') return { x, y };
    }
  }
  return { x: 1, y: 1 };
}
```

Four changes to track against chapter 06:

- **`Entity` gains `displayName`.** Echoed from the Player
  actor on join; the renderer uses it for hover text in a
  future chapter.
- **`RoomState.spawn`** is computed once in `onInit`. Stable
  spawn point per room.
- **`addEntity` handler** is new. Idempotent — calling join
  twice for the same player is a no-op. (We need idempotence
  because chapter 08's room transitions can racy-retry.)
- **`move` takes `playerId`** instead of operating on the
  hardcoded `'player'`. Throws if the player isn't in the
  room — chapter 12 will replace the `throw` with a structured
  `400 PlayerNotInRoom` problem-detail, but the throw is fine
  for now.

The `tick` handler doesn't change shape — it already iterated
over `state.entities`. Multi-player movement falls out for
free.

## Register the Player class

Open `src/server.ts` and add the registration alongside the
existing `Room`:

```ts
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import { Runtime } from '@jplevyak/actjs/runtime';
import { buildApp } from '@jplevyak/actjs/server';
import { MemoryStorageDriver } from '@jplevyak/actjs/storage';
import { asClassName, asVersion } from '@jplevyak/actjs/types';

import { Player } from './player.js';
import { Room } from './room.js';

const driver = new MemoryStorageDriver();
await driver.init();

const runtime = new Runtime(driver);
runtime.register({
  name: asClassName('Room'),
  version: asVersion('1.0.0'),
  ctor: Room,
});
runtime.register({
  name: asClassName('Player'),
  version: asVersion('1.0.0'),
  ctor: Player,
});

// ... buildApp + static plugin + listen + shutdown (unchanged) ...
```

One extra `runtime.register({...})`. The REST and WS routes for
`Player` light up immediately:

| Verb   | Path                            | Notes                         |
| ------ | ------------------------------- | ----------------------------- |
| `POST` | `/v1/actors/Player`             | Mint a fresh player id.       |
| `POST` | `/v1/actors/Player/:id/:method` | Invoke `whoami`, `join`, etc. |
| `GET`  | `/v1/actors/Player/:id`         | Raw snapshot.                 |

## Update the browser

The browser needs three changes:

1. Read or mint a `playerId` and persist it in `localStorage`.
2. Call `Player.<id>/join({roomId})` on load before subscribing.
3. Pass `playerId` on every `move` call.
4. Render entities with hash-derived colors so two players are
   visually distinct.

Edit `public/main.js`:

```js
import { WsClient } from './ws-client.js';

const TILE = 24;

const TILE_STYLES = {
  '#': { color: '#3a3a3a', glyph: '' },
  '.': { color: '#161616', glyph: '' },
  '+': { color: '#a87a25', glyph: '+' },
};
const UNKNOWN_TILE = { color: '#ff00ff', glyph: '?' };

async function rpc(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getOrMintPlayer() {
  let id = localStorage.getItem('actjs.playerId');
  if (id) return id;
  const minted = await rpc('/v1/actors/Player');
  id = minted.id;
  localStorage.setItem('actjs.playerId', id);
  return id;
}

async function getOrMintRoom() {
  const params = new URLSearchParams(location.search);
  let id = params.get('id');
  if (id) return id;
  const minted = await rpc('/v1/actors/Room');
  id = minted.id;
  history.replaceState(null, '', `?id=${id}`);
  return id;
}

/** Stable color per player id via FNV-1a hash → HSL hue. */
function colorForPlayer(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return `hsl(${h % 360}, 70%, 65%)`;
}

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
    ctx.fillStyle = colorForPlayer(e.id);
    ctx.fillText('@', e.x * TILE + TILE / 2, e.y * TILE + TILE / 2);
  }
}

async function main() {
  const [playerId, roomId] = await Promise.all([getOrMintPlayer(), getOrMintRoom()]);

  // Confirm identity. If the server has lost state (memory
  // driver across restart), `whoami` re-materializes the player
  // with the same id but a fresh snapshot — acceptable for the
  // tutorial; chapter 18's PG driver fixes restart durability.
  const who = await rpc(`/v1/actors/Player/${playerId}/whoami`);
  document.getElementById('roomId').textContent = roomId;
  document.getElementById('playerInfo').textContent =
    `${who.result.displayName} (${playerId.slice(-8)})`;

  // Join the room. The Player handler updates currentRoomId
  // and tells the room to add our entity.
  await rpc(`/v1/actors/Player/${playerId}/join`, { roomId });

  const canvas = document.getElementById('dungeon');
  const wsUrl = `${location.origin.replace(/^http/, 'ws')}/v1/ws`;
  const client = new WsClient(wsUrl);
  await client.connect();
  await client.subscribe('Room', roomId, (state) => render(canvas, state));

  canvas.addEventListener('click', async (event) => {
    const rect = canvas.getBoundingClientRect();
    const tx = Math.floor((event.clientX - rect.left) / TILE);
    const ty = Math.floor((event.clientY - rect.top) / TILE);
    await rpc(`/v1/actors/Room/${roomId}/move`, { playerId, x: tx, y: ty });
  });
}

main().catch((err) => {
  document.body.innerHTML = `<pre style="color:#f55;padding:1rem">${err.stack}</pre>`;
});
```

What changed from chapter 06:

- **`getOrMintPlayer`** persists identity in `localStorage`
  under `actjs.playerId`. First load mints; subsequent loads
  reuse.
- **`whoami` confirmation.** Read-only sanity check; surfaces
  the displayName in the UI.
- **`join` before subscribe.** The room actor doesn't have your
  entity until you call `join`, so any subscriber snapshot
  delivered before the join completes would miss you. Awaiting
  `join` ensures the subscription's first snapshot includes
  your `@`.
- **`move` now sends `{playerId, x, y}`.** The room looks up
  your entity by `playerId`.
- **`colorForPlayer`** in the renderer. Same FNV-1a hash trick
  from chapter 03's `hashStringToSeed`, but hashing into HSL
  hue space. Two players → two visibly distinct `@`s.
- **`ENTITY_STYLES` is gone.** Color-per-id replaces the
  static map; one less thing to keep in sync when entity types
  grow.

Update `public/index.html` to surface the player label:

```html
<div class="meta">
  <span>Player: <code id="playerInfo">…</code></span>
  <span>Room: <code id="roomId">…</code></span>
  <a href="?">fresh dungeon</a>
</div>
```

A reset-your-player escape valve helps when testing:

```html
<a href="javascript:localStorage.removeItem('actjs.playerId'); location.href = '?'">
  new identity
</a>
```

(Don't write `javascript:` URLs in production; they're fine in
a tutorial.)

## Run it

```bash
pnpm dev
```

Open the page in **two private/incognito windows** (or two
different browsers). Each window has its own `localStorage`, so
each mints a distinct `playerId`. Paste tab 1's URL into tab 2
so they share the same `?id=...` for the room.

Both tabs should display two `@` glyphs in distinct colors at
the spawn point. Click in tab 1: that tab's `@` walks. Tab 2
sees it walk in real time (subscription patches). Click in tab
2: that tab's `@` walks; tab 1 sees it.

Try a few:

- **Different rooms.** Open tab 3 with no `?id=` — it mints a
  fresh room. Tab 3 is alone in its room; tabs 1 and 2 don't
  see tab 3. Subscriptions are scoped by room.
- **Reload one tab.** The player id from localStorage comes
  back; the player walks back into the room at the spawn point
  (their entity is re-added, idempotently). The other tab sees
  the entity disappear and reappear briefly (the rejoin is
  effectively "remove + add" if you'd left the room, or a no-op
  if you hadn't).
- **"New identity" link.** localStorage clears; the next page
  load mints a fresh `Player`. Three `@`s in the room now,
  because the abandoned player entity is still in the room's
  state. Chapter 08's room-transitions add a "leave" flow that
  cleans these up.

## Where the cross-actor call shows up in the wire log

If you watch the server logs during `POST /v1/actors/Player/<id>/join`,
you don't see a separate HTTP request to the room — the room is
called in-process via `this.actjs!.call`. From the browser's
perspective the join is one request. From the server's
perspective the Player handler awaits the Room handler in a
single async chain. The mailbox semantics on both actors
guarantee the work serializes correctly even under concurrent
joins.

The WS subscription frame for the room _does_ fire — the
room's `addEntity` mutated state, which produced a patch:

```json
{
  "jsonrpc": "2.0",
  "method": "actor.event",
  "params": {
    "subscriptionId": "...",
    "kind": "patch",
    "patch": [
      {
        "op": "add",
        "path": "/entities/0",
        "value": {
          "id": "019e...",
          "displayName": "Player-c0ff",
          "x": 8,
          "y": 7,
          "path": []
        }
      }
    ]
  }
}
```

The chapter-06 `applyPatch` handles `add` on arrays correctly,
so the new entity appears in subscribers' renderers without
any new client-side code. The hand-rolled JSON Patch from ch
06 has been paying off in the background.

## Commit + tag

```bash
git add .
git commit -m "ch07: Player actor; cross-actor join; multi-player"
git tag ch07-done
```

## Recap

Two new actjs concepts:

1. **A second actor class.** Cheap. One `runtime.register({...})`
   call adds the full REST + WS surface for `Player`. The same
   framework primitives (handlers, snapshots, subscriptions)
   work for both classes.
2. **Cross-actor `this.actjs.call(ref, method, args)`.** The
   in-process RPC between actors. Same mailbox semantics as a
   wire-side call; the framework routes through the target
   actor's mailbox. Request/response shape; use `tell` for
   fire-and-forget. This is the primitive that will carry the
   merchant flow (ch 10), the room-transition saga (ch 08),
   the party loot roll (ch 15) — every cross-cutting pattern
   in the tutorial uses it.

Plus two craft moves that aren't actjs-specific but matter:

- **localStorage for client-side identity persistence.** The
  player id outlives any session; the browser remembers who it
  is across reloads.
- **Hash-derived color per id.** Visual distinction between
  entities without a per-id config table. Same trick we used
  in chapter 03 for the per-actor procgen seed.

What didn't change: `Room.tick`, `findPath`, the renderer's
two-pass layered draw, the chapter-06 subscription + JSON Patch
plumbing. None of those concepts needed a multi-actor
generalization — they were already shaped for it.

## What's next

**Chapter 08 — Room transitions** is the next-natural extension:
walk onto a door tile and end up in the neighboring room. This
exercises a real cross-actor saga: leave room A, update the
player, enter room B. It also introduces idempotency-keyed
retries (so a network blip doesn't double-spawn the player) and
the "no atomic across actors" rule that motivates sagas
specifically. After that, **chapter 09** wires up the `Dungeon`
actor that pre-generates a graph of room ids so transitions
know where to go.

---

## Troubleshooting

**Player keeps spawning at the same tile and overlaps with
another player**

That's the design — `spawn` is computed once in `Room.onInit`
and reused. The first player at the spawn tile, the second at
the same tile (overlapping `@`s render as a single colored
`@` because we draw later entities over earlier ones). Click
in one tab to walk away and you'll see both. Chapter 10 will
add a "pick a random open floor tile" spawn policy when
merchants land.

**"player X is not in this room"**

You called `move` before `join` resolved, or the browser
session has a stale `playerId` from a server restart that
lost state. Click the "new identity" link to clear localStorage
and reload.

**Two browser tabs in the same window share state**

`localStorage` is keyed by origin, not by tab. Two tabs in the
same browser session see the same player id. Use a private
window or a different browser to get a distinct identity.

**Player `whoami` says `currentRoomId: null` even after join**

The chapter-06 subscription cached state from before your
join completed. Either await `join` before `subscribe` (the
chapter does this), or check the network panel — if `join`
returned 4xx/5xx, the `currentRoomId` write didn't land.

**`Cannot read properties of undefined (reading 'call')`**

`this.actjs` was `undefined` in your handler. The runtime sets
it on activation; if you're testing the Player class via
`new Player()` directly (without `TestRuntime`), the bridge
isn't attached. Use `@jplevyak/actjs/test`'s `TestRuntime` (see
`docs/testing.md`) for unit tests.

**Multiple players join but the patches arrive out of order**

They don't — the Room's mailbox serializes `addEntity` calls
and patches are emitted strictly per turn. If you see what
looks like reordering, check whether two browser tabs each
subscribed late and got different snapshots; subsequent
patches will reconcile within a tick.

**`history.replaceState` clears my session on reload**

It shouldn't. `replaceState` updates the URL but doesn't
touch localStorage, where the playerId lives. The roomId
arrives from `?id=...` and re-mints if absent — that's
expected for the "fresh dungeon" link, intentional for the
room URL pattern.
