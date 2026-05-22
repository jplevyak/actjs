# Chapter 09 — Procgen graph of rooms

> **Chapter goal:** introduce a `Dungeon` actor that owns the
> room graph. Doors stop leading to random new rooms (ch 08) and
> start leading to deterministic neighbors. Rooms still
> materialize lazily — only when a player walks into them. The
> dungeon is now a real navigable space.
>
> **Time budget:** ~75 minutes.
>
> **End-of-chapter tag:** `ch09-done`.

---

Chapter 08's transition saga worked, but every door led to a
freshly-minted room. Walking north then south didn't bring you
back; you accumulated an unbounded tree of orphaned dungeons.
This chapter fixes that.

The actjs lesson is two-part:

- **A coordinator actor** owns metadata about a set of other
  actors. In our case the `Dungeon` actor owns the grid that
  maps `(roomId, direction) → neighborRoomId`. Players ask it
  where to go; rooms know nothing about each other.
- **Lazy materialization** keeps the dungeon cheap. The Dungeon
  doesn't pre-create every Room actor on boot. It just knows
  about their ids. The first time a player walks into a given
  room, that Room actor materializes (chapter 02 promised this;
  chapter 09 finally exercises it at scale).

The two-level procgen story is itself worth naming: the room's
_interior_ is owned by the Room actor (chapter 03's drunkard's
walk), while the room _layout_ is owned by the Dungeon. The
boundary between the two is the actor boundary — the natural
place to split the algorithm.

By the end of this chapter you will:

- Have a `Dungeon` actor with handlers `enter` (spawn a player
  in the entry room) and `neighborOf` (return the neighbor for
  a given room + direction).
- Have `Room` actors whose `actor_id` encodes their grid
  position, so each Room independently knows which directions
  carry doors.
- Have replaced `Player.transitionThroughDoor`'s
  `randomUUID()` with a `Dungeon.neighborOf` call. Walking N
  then S returns you to your starting room.
- Have a browser that mints / pins a `Dungeon` (not a `Room`)
  via the URL, with `?dungeon=<id>` taking over from `?id=`.

## The actor topology now

```
World
 ├── Dungeon (×N)         (one per active dungeon instance)
 │     └── size: 3        (grid is 3×3 — DUNGEON_SIZE constant)
 │     └── (no per-room state; the graph is implicit in the grid)
 ├── Room (×N)            (one per "visited" cell of a dungeon's grid)
 │     ├── actor_id: "dungeon-019e...:x:y"  (encodes grid position)
 │     ├── doors derived from (x, y) and DUNGEON_SIZE
 │     └── ...everything else from ch 02–08...
 └── Player (×N)          (unchanged from ch 07; saga handlers
                           from ch 08 retargeted at the Dungeon)
```

The `Dungeon` actor is the meta-level one. Its job is small:

- On `onInit`, record the grid size (a constant for chapter 09 —
  we'll make this configurable later).
- On `enter({playerId})`, pick the spawn room (the `(0, 0)`
  corner) and forward the entity into it.
- On `neighborOf({fromRoomId, direction})`, parse the source
  room's grid position, apply the direction, and return the
  neighbor's room id (or `null` if the move goes off-grid).

That's the whole Dungeon. No per-room metadata, no MST, no
random placement. Just a 3×3 grid where every adjacent pair is
connected, and rooms encode their own position. The `Why not
MST?` callout below addresses what we'd add if we wanted a
sparser graph.

## Define the Dungeon actor

Create `src/dungeon.ts`:

```ts
import { Actor } from '@jplevyak/actjs/actor';
import { handler } from '@jplevyak/actjs/handler';
import type { ActorRef } from '@jplevyak/actjs/types';
import { asActorId, asClassName, asVersion } from '@jplevyak/actjs/types';

/** Width and height of the dungeon grid (rooms per side). */
export const DUNGEON_SIZE = 3;

export type Direction = 'N' | 'S' | 'E' | 'W';

export interface DungeonState {
  size: number;
}

export class Dungeon extends Actor<DungeonState> {
  override onInit(): void {
    this.state = { size: DUNGEON_SIZE };
  }

  /**
   * Spawn a player in the dungeon's entry room. Returns the room
   * id the player ends up in; the Player handler stores it as
   * `currentRoomId`.
   */
  @handler('enter')
  async enter(args: { playerId: string; displayName: string }): Promise<{
    roomId: string;
  }> {
    const roomId = roomIdFor(this.actor_id as string, 0, 0);
    const room: ActorRef = {
      class: asClassName('Room'),
      id: asActorId(roomId),
      version: asVersion('1.0.0'),
    };
    await this.actjs!.call(room, 'addEntity', {
      playerId: args.playerId,
      displayName: args.displayName,
    });
    return { roomId };
  }

  /**
   * Look up the neighbor of `fromRoomId` in the given direction.
   * Returns `null` if the direction goes off-grid.
   *
   * The 3×3 full-connectivity layout means every adjacent pair
   * is a neighbor; if you want sparser dungeons, this is the
   * place to consult an MST or hand-curated graph.
   */
  @handler('neighborOf')
  neighborOf(args: { fromRoomId: string; direction: Direction }): {
    roomId: string;
  } | null {
    const parsed = parseRoomId(args.fromRoomId);
    if (!parsed) return null;
    const { dungeonId, x, y } = parsed;
    const [nx, ny] = step(x, y, args.direction);
    if (nx < 0 || nx >= this.state.size) return null;
    if (ny < 0 || ny >= this.state.size) return null;
    return { roomId: roomIdFor(dungeonId, nx, ny) };
  }
}

/* ----------------------------------------------------- room-id encoding */

/**
 * Compose a Room actor id from a Dungeon id + grid coordinates.
 * Encoding the grid position into the actor id is what lets each
 * Room independently know which directions carry doors without
 * consulting the Dungeon during `onInit`.
 */
export function roomIdFor(dungeonId: string, x: number, y: number): string {
  return `${dungeonId}:${x}:${y}`;
}

/** Inverse of `roomIdFor`. Returns `null` for free-form room ids. */
export function parseRoomId(roomId: string): {
  dungeonId: string;
  x: number;
  y: number;
} | null {
  const parts = roomId.split(':');
  if (parts.length !== 3) return null;
  const [dungeonId, xs, ys] = parts;
  if (!dungeonId || xs === undefined || ys === undefined) return null;
  const x = Number(xs);
  const y = Number(ys);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  return { dungeonId, x, y };
}

export function step(x: number, y: number, dir: Direction): [number, number] {
  switch (dir) {
    case 'N':
      return [x, y - 1];
    case 'S':
      return [x, y + 1];
    case 'E':
      return [x + 1, y];
    case 'W':
      return [x - 1, y];
  }
}
```

Three pieces of intent worth pausing on:

- **The grid is in the actor id, not the Dungeon's state.** Both
  the Dungeon and the Room can derive grid positions from a
  Room's `actor_id`. The Dungeon doesn't need to track "which
  rooms have been visited" — visiting a room just materializes
  it, and the room knows its own coordinates by parsing
  `actor_id`.
- **`neighborOf` is a pure read.** No state mutation; the
  Dungeon stays a tiny, cheap actor. Even with hundreds of
  players walking around concurrently, the Dungeon's mailbox
  serializes pure reads, which is fast.
- **`enter` is the bootstrap.** Players never directly mint
  Rooms in a dungeon; they enter via the Dungeon, which picks
  the spawn. This means the Dungeon is the only thing that
  knows where in the grid the entry is — useful for chapter 10
  when we want different entry policies per dungeon flavor.

### Why not MST?

The outline mentions "grid placement + minimum spanning tree" as
the algorithm for ch 09. A full 3×3 grid sidesteps it — every
cell is occupied, every adjacent pair is a neighbor, no algorithm
to run. The reasons to add MST back:

- **Sparser dungeons.** Drop _N_ rooms at random points on a
  larger grid (say 5×5 with 12 rooms), connect them with an MST
  so the graph stays connected, then sprinkle a few extra
  edges so it isn't a pure tree. ~40 lines of additional code
  in `Dungeon.onInit`.
- **Variable shape.** Some rooms have one door, some four; the
  layout looks like a corridor with branches rather than a
  uniform grid.

Both belong in a follow-up. The 3×3 full grid is the smallest
thing that exercises the **coordinator + lazy materialization**
lesson, which is the chapter's actual point.

## Update the Room to install grid doors

Edit `src/room.ts`. Two changes:

1. Parse `(x, y)` from `actor_id`. If the room is part of a
   dungeon grid, install doors at the boundary tiles where a
   neighbor exists.
2. The `tick` handler now reports a `direction` along with
   `fromRoomId` when an entity steps onto a door, so the
   Player handler can ask the Dungeon for the right neighbor.

The full file:

```ts
import { Actor } from '@jplevyak/actjs/actor';
import { handler } from '@jplevyak/actjs/handler';
import type { ActorRef } from '@jplevyak/actjs/types';
import { asActorId, asClassName, asVersion } from '@jplevyak/actjs/types';

import { DUNGEON_SIZE, parseRoomId, type Direction } from './dungeon.js';
import { findPath, isPassable, type Point } from './pathfinding.js';
import { drunkardsWalk } from './procgen.js';
import { hashStringToSeed } from './rng.js';

const WIDTH = 20;
const HEIGHT = 20;
const TICK_MS = 200;

export interface Entity {
  id: string;
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
  spawn: Point;
  tickScheduled: boolean;
}

export class Room extends Actor<RoomState> {
  override onInit(): void {
    const seed = hashStringToSeed(this.actor_id as string);
    const tiles = drunkardsWalk({ width: WIDTH, height: HEIGHT, seed });
    // If this room is part of a dungeon grid, overlay doors at
    // the boundary tiles where a neighbor exists.
    const grid = parseRoomId(this.actor_id as string);
    if (grid) installGridDoors(tiles, grid.x, grid.y);

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

  @handler('removeEntity')
  removeEntity(args: { playerId: string }): { ok: true } {
    this.state.entities = this.state.entities.filter((e) => e.id !== args.playerId);
    return { ok: true };
  }

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
    const transitions: { entity: Entity; direction: Direction }[] = [];

    for (const e of this.state.entities) {
      const next = e.path.shift();
      if (next) {
        e.x = next.x;
        e.y = next.y;
      }
      // Did this entity step onto a door tile?
      const tile = this.state.tiles[e.y]?.[e.x];
      if (tile === '+') {
        const dir = doorDirection({ x: e.x, y: e.y });
        if (dir) transitions.push({ entity: e, direction: dir });
      }
    }

    for (const t of transitions) {
      this.state.entities = this.state.entities.filter((e) => e.id !== t.entity.id);
      const player: ActorRef = {
        class: asClassName('Player'),
        id: asActorId(t.entity.id),
        version: asVersion('1.0.0'),
      };
      await this.actjs!.tell(player, 'transitionThroughDoor', {
        fromRoomId: this.actor_id as string,
        direction: t.direction,
      });
    }

    const anyMoving = this.state.entities.some((e) => e.path.length > 0);
    if (anyMoving) await this.ensureTickRunning();
  }

  private async ensureTickRunning(): Promise<void> {
    if (this.state.tickScheduled) return;
    this.state.tickScheduled = true;
    await this.actjs!.scheduleAt(this.actjs!.now() + TICK_MS, 'tick', {});
  }
}

/* --------------------------------------------------- door installation */

function installGridDoors(tiles: string[], gridX: number, gridY: number): void {
  const W = tiles[0]!.length;
  const H = tiles.length;
  const midX = Math.floor(W / 2);
  const midY = Math.floor(H / 2);

  if (gridY > 0) tiles[0] = replaceCharAt(tiles[0]!, midX, '+');
  if (gridY < DUNGEON_SIZE - 1) tiles[H - 1] = replaceCharAt(tiles[H - 1]!, midX, '+');
  if (gridX > 0) tiles[midY] = replaceCharAt(tiles[midY]!, 0, '+');
  if (gridX < DUNGEON_SIZE - 1) tiles[midY] = replaceCharAt(tiles[midY]!, W - 1, '+');
}

function replaceCharAt(s: string, i: number, ch: string): string {
  return s.slice(0, i) + ch + s.slice(i + 1);
}

/** Returns the cardinal direction of a door tile, or null. */
function doorDirection(pos: Point): Direction | null {
  const midX = Math.floor(WIDTH / 2);
  const midY = Math.floor(HEIGHT / 2);
  if (pos.y === 0 && pos.x === midX) return 'N';
  if (pos.y === HEIGHT - 1 && pos.x === midX) return 'S';
  if (pos.x === 0 && pos.y === midY) return 'W';
  if (pos.x === WIDTH - 1 && pos.y === midY) return 'E';
  return null;
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

Three things to note:

- **`parseRoomId(this.actor_id as string)` in `onInit`.** Free-form
  room ids (the ones we minted via `POST /v1/actors/Room` in
  earlier chapters) don't match the `dungeonId:x:y` format and
  parse as `null` — the room then skips door installation and
  behaves exactly like chapter 03. So a single `Room` class
  cleanly serves both "naked" rooms (legacy) and dungeon
  rooms (new).
- **Doors at fixed boundary positions.** The room's procgen
  doesn't guarantee a path to the boundary tiles. If the
  drunkard's walk leaves the boundary surrounded by walls,
  the door is "stranded" — visible but unreachable. We'll
  accept this as a known minor flaw; a proper fix (carve a
  short corridor from the nearest floor tile to each door)
  belongs in a procgen-hardening pass.
- **`tick` reports a `direction`.** The Room knows which door
  the entity stepped onto by checking its grid-position
  coordinates; this gets passed to the Player so the Dungeon
  lookup is unambiguous.

## Update the Player

Two changes in `src/player.ts`:

1. `join` now takes a `dungeonId` and calls `Dungeon.enter` instead
   of `Room.addEntity` directly.
2. `transitionThroughDoor` now takes a `direction` and asks the
   Dungeon for the neighbor before joining it.

```ts
import { Actor } from '@jplevyak/actjs/actor';
import { handler } from '@jplevyak/actjs/handler';
import type { ActorRef } from '@jplevyak/actjs/types';
import { asActorId, asClassName, asVersion } from '@jplevyak/actjs/types';

import { parseRoomId, type Direction } from './dungeon.js';

export interface PlayerState {
  displayName: string;
  currentRoomId: string | null;
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
   * Enter a dungeon. The Dungeon decides where to spawn us; we
   * record the room id it returns.
   */
  @handler('join')
  async join(args: { dungeonId: string }): Promise<{
    displayName: string;
    roomId: string;
  }> {
    const dungeon: ActorRef = {
      class: asClassName('Dungeon'),
      id: asActorId(args.dungeonId),
      version: asVersion('1.0.0'),
    };
    const { roomId } = await this.actjs!.call<{ roomId: string }>(dungeon, 'enter', {
      playerId: this.actor_id as string,
      displayName: this.state.displayName,
    });
    this.state.currentRoomId = roomId;
    return { displayName: this.state.displayName, roomId };
  }

  @handler('whoami')
  whoami(): { id: string; displayName: string; currentRoomId: string | null } {
    return {
      id: this.actor_id as string,
      displayName: this.state.displayName,
      currentRoomId: this.state.currentRoomId,
    };
  }

  /**
   * Complete a door-step transition. The originating room has
   * already removed our entity. We ask the Dungeon for the
   * neighbor in the given direction; if found, we join it.
   * Idempotent across the three saga steps (see ch 08).
   */
  @handler('transitionThroughDoor')
  async transitionThroughDoor(args: {
    fromRoomId: string;
    direction: Direction;
  }): Promise<{ newRoomId: string } | { ok: false }> {
    // Defensive removeEntity (idempotent).
    if (args.fromRoomId === this.state.currentRoomId) {
      const oldRoom: ActorRef = {
        class: asClassName('Room'),
        id: asActorId(args.fromRoomId),
        version: asVersion('1.0.0'),
      };
      await this.actjs!.call(oldRoom, 'removeEntity', {
        playerId: this.actor_id as string,
      });
    }

    // Ask the Dungeon where to go.
    const parsed = parseRoomId(args.fromRoomId);
    if (!parsed) return { ok: false };
    const dungeon: ActorRef = {
      class: asClassName('Dungeon'),
      id: asActorId(parsed.dungeonId),
      version: asVersion('1.0.0'),
    };
    const neighbor = await this.actjs!.call<{ roomId: string } | null>(dungeon, 'neighborOf', {
      fromRoomId: args.fromRoomId,
      direction: args.direction,
    });
    if (!neighbor) return { ok: false };

    // Update state + spawn into the new room.
    this.state.currentRoomId = neighbor.roomId;
    const newRoom: ActorRef = {
      class: asClassName('Room'),
      id: asActorId(neighbor.roomId),
      version: asVersion('1.0.0'),
    };
    await this.actjs!.call(newRoom, 'addEntity', {
      playerId: this.actor_id as string,
      displayName: this.state.displayName,
    });
    return { newRoomId: neighbor.roomId };
  }
}
```

What's the same as chapter 08:

- The three-step saga structure.
- The defensive `removeEntity` for retry safety.
- The `addEntity` call at the end to materialize the new room.

What's different:

- `join` takes `dungeonId`, not `roomId`. The browser doesn't
  pick the spawn; the Dungeon does.
- `transitionThroughDoor` takes `direction` and looks up the
  neighbor via the Dungeon. The "every door leads somewhere
  new" behavior is gone; doors now have deterministic
  destinations.
- The `{ ok: false }` return when there's no neighbor (e.g.,
  stepping on a door at the dungeon's edge — shouldn't
  happen with the grid-door installation, but defensive).

## Register the Dungeon class

Open `src/server.ts` and register `Dungeon` alongside `Room`
and `Player`:

```ts
import { Dungeon } from './dungeon.js';
// ... existing imports ...

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
runtime.register({
  name: asClassName('Dungeon'),
  version: asVersion('1.0.0'),
  ctor: Dungeon,
});
```

That's it on the server side — REST and WS routes for `Dungeon`
light up automatically.

## Update the browser

The browser now mints / pins a `Dungeon`, not a `Room`. The
URL parameter changes from `?id=<roomId>` to
`?dungeon=<dungeonId>`. The Room subscription still happens —
it just swaps over as the Player's `currentRoomId` changes
(this part is unchanged from chapter 08).

Update `public/main.js`. The `getOrMintRoom` function becomes
`getOrMintDungeon`; the call into `Player.join` passes
`{dungeonId}`:

```js
async function getOrMintDungeon() {
  const params = new URLSearchParams(location.search);
  let id = params.get('dungeon');
  if (id) return id;
  const minted = await rpc('/v1/actors/Dungeon');
  id = minted.id;
  history.replaceState(null, '', `?dungeon=${id}`);
  return id;
}

async function main() {
  const [playerId, dungeonId] = await Promise.all([getOrMintPlayer(), getOrMintDungeon()]);
  document.getElementById('playerInfo').textContent = playerId.slice(-8);
  document.getElementById('dungeonInfo').textContent = dungeonId.slice(-8);

  const canvas = document.getElementById('dungeon');
  const wsUrl = `${location.origin.replace(/^http/, 'ws')}/v1/ws`;
  const client = new WsClient(wsUrl);
  await client.connect();

  let roomUnsub = null;
  let activeRoomId = null;

  async function switchToRoom(newRoomId) {
    if (newRoomId === activeRoomId) return;
    if (roomUnsub) {
      await roomUnsub();
      roomUnsub = null;
    }
    activeRoomId = newRoomId;
    document.getElementById('roomId').textContent = newRoomId;
    roomUnsub = await client.subscribe('Room', newRoomId, (state) => render(canvas, state));
  }

  // Subscribe to the Player to observe `currentRoomId` changes.
  await client.subscribe('Player', playerId, (state) => {
    if (state.currentRoomId && state.currentRoomId !== activeRoomId) {
      void switchToRoom(state.currentRoomId);
    }
  });

  // Initial join. The Dungeon decides the spawn room; the
  // Player subscription picks up `currentRoomId` and triggers
  // `switchToRoom`.
  await rpc(`/v1/actors/Player/${playerId}/join`, { dungeonId });

  canvas.addEventListener('click', async (event) => {
    if (!activeRoomId) return;
    const rect = canvas.getBoundingClientRect();
    const tx = Math.floor((event.clientX - rect.left) / TILE);
    const ty = Math.floor((event.clientY - rect.top) / TILE);
    await rpc(`/v1/actors/Room/${activeRoomId}/move`, { playerId, x: tx, y: ty });
  });
}
```

Update `public/index.html` to show the dungeon id in the
header strip:

```html
<div class="meta">
  <span>Player: <code id="playerInfo">…</code></span>
  <span>Dungeon: <code id="dungeonInfo">…</code></span>
  <span>Room: <code id="roomId">…</code></span>
  <a href="?">fresh dungeon</a>
</div>
```

The "fresh dungeon" link strips the URL and mints a new one.

## Run it

```bash
pnpm dev
```

Open the page. The URL becomes `?dungeon=<id>`. You spawn in the
`(0, 0)` corner of a 3×3 grid. The room has two doors — south
and east (the corner has no neighbors to the north or west).

Walk through the east door. You enter the `(1, 0)` room — a
new room, freshly materialized. The east door of `(0, 0)` and
the west door of `(1, 0)` are the same edge. The new room has
doors on three sides (N, S, E aren't blocked except at the
grid's top edge), reflecting its position.

Walk west — and you return to `(0, 0)`. The Room actor is
still alive (memory driver, no eviction in this session); the
entity is added back at the spawn point. The dungeon is now
a real navigable space.

Try a few:

- **Walk the full 3×3 grid.** Each visit materializes a new
  Room on first touch; subsequent visits reuse the same
  actor. The total dungeon footprint is 9 Room actors + 1
  Dungeon actor + 1 Player actor.
- **Two browser tabs in the same dungeon.** Share the URL.
  Both players spawn in `(0, 0)`. As one walks east into
  `(1, 0)`, the other sees their entity disappear (room
  subscription) — but the second player is still in
  `(0, 0)` and doesn't switch rooms (their
  `Player.currentRoomId` is unchanged).
- **One walks east, the other walks east later.** The
  second player ends up in the same `(1, 0)` room as the
  first. Now they're both in `(1, 0)`. Movements broadcast
  to both because they share a Room subscription.

## What the wire looks like

Pop the Network panel's WS Messages view. Walking through a
door produces, in order:

1. **`Room (0,0)` patch** — entity stepped on the east door;
   the room removes the entity and emits a `remove` patch.
2. **`Player` patch** — `currentRoomId` flips from
   `dungeon-xxx:0:0` to `dungeon-xxx:1:0`.
3. **(client-driven) `actor.subscribe` request** — the browser
   tears down its `Room (0,0)` subscription and subscribes to
   `Room (1,0)`.
4. **`Room (1,0)` snapshot** — full state of the new room,
   including the entity that was just spawned there by
   `Player.transitionThroughDoor`'s `addEntity` call.

The wire protocol from ch 06 carries all four cleanly. The only
new round-trips are the `Dungeon.neighborOf` calls, which happen
in-process between actors and never touch the wire.

## Commit + tag

```bash
git add .
git commit -m "ch09: Dungeon actor + room graph; deterministic transitions"
git tag ch09-done
```

## Recap

| New concept                             | Where it lives                                           |
| --------------------------------------- | -------------------------------------------------------- |
| Coordinator actor (Dungeon)             | `src/dungeon.ts`                                         |
| Compound actor ids (`dungeonId:x:y`)    | `roomIdFor` / `parseRoomId`                              |
| Lazy materialization at the graph level | `addEntity` is what materializes a Room — never explicit |
| Directional door routing                | `Room.tick` reports `direction`; `Player` uses it        |
| Cardinal door installation              | `installGridDoors` in `src/room.ts`                      |

What didn't change:

- The chapter 08 saga shape (`removeEntity → currentRoomId →
addEntity`). Only step 2's "where to" changed.
- The `WsClient`, the JSON Patch applier, the canvas renderer.
- `Room.move`, `Room.tick` mechanics; `Player.whoami`;
  `Player.join`'s saga shape.
- `Player.currentRoomId` is still the single source of truth
  for browser-side room switching.

What we deferred (with markers):

- **MST + random placement.** The full 3×3 grid is the
  simplest dungeon shape; sparser dungeons live in a future
  chapter.
- **Stranded doors.** Procgen can leave the boundary tiles
  walled-off from the carved region. The door is visible but
  unreachable. A "carve a corridor to each door" pass is a
  one-function fix; left as an exercise.
- **Multi-floor dungeons.** Up / down stairs would be a third
  doors category. Skipped.

## What's next

**Chapter 10 — Merchants** is the next chapter and the first
true cross-cutting actor pattern. A `Merchant` actor with one
durable inventory can appear in multiple rooms simultaneously
— buying his last sword in one room makes it unavailable in
the other. The mechanics use the same primitives we now have
(cross-actor calls, subscription patches), but the design
question is new: how do you model identity across location?

---

## Troubleshooting

**"player X is not in this room" right after a transition**

The browser sent a `move` for the new room before its
subscription's snapshot arrived. The `activeRoomId` guard in
the click handler should prevent this; if you see it firing,
check that `activeRoomId` is being set in `switchToRoom`
before the snapshot listener runs.

**Door at the boundary but the player can't reach it**

That's the "stranded door" case mentioned above. The
drunkard's walk left the boundary surrounded by walls; the
door tile is visible but A\* finds no path. Click somewhere
else first to verify the player can still move, then accept
that this specific room's door is decorative until we ship
a connectivity pass.

**Walking through a door does nothing**

Either the room isn't a dungeon room (check the URL — does
it have `?dungeon=...`? does `parseRoomId` succeed on the
current room id?), or the Dungeon returned `null` from
`neighborOf` (off-grid). Open the browser's Network panel
and look at the response of
`POST /v1/actors/Player/<id>/transitionThroughDoor`.

**Two players in the same room walk through the same door but
end up in different rooms**

They shouldn't — the Dungeon's `neighborOf` is deterministic
per `(fromRoomId, direction)`. If you're seeing this, check
that both players are in the same dungeon (their
`fromRoomId` should share the same `dungeonId:` prefix).
Different dungeons = different graphs = different
neighbors.

**The "fresh dungeon" link reloads to the same dungeon**

The URL was cleared but `localStorage.actjs.playerId` still
points at a Player whose `currentRoomId` is set. The
`whoami` snapshot fires `switchToRoom` to the old room
before `join` updates `currentRoomId`. Add a `?` redirect
or clear `currentRoomId` server-side via a new
`Player.leaveDungeon` handler — left as a polish item.
