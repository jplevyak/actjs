# Chapter 05 — Click-to-move + server pathfinding

> **Chapter goal:** click a floor tile in the browser; a player
> character walks to it. The path is computed by A\* on the
> server, the player moves one tile per 200 ms via a self-scheduled
> tick loop, and the renderer polls the room snapshot once per
> tick to see the move. Chapter 06 swaps polling for WS
> subscriptions; this chapter is where polling earns its
> retirement.
>
> **Time budget:** ~60 minutes.
>
> **End-of-chapter tag:** `ch05-done`.

---

This is the chapter where the dungeon stops being a static
painting and becomes a game. Three things land here, in this
order: an A\* pathfinder, a fixed-tick simulation, and a click
handler in the browser. Of the three, only the tick loop is
new-to-actjs — A\* and the click handler are vanilla
TypeScript/JavaScript that would look the same in any backend.

The actjs lesson buried in this chapter: **the room actor wakes
itself up.** There's no setInterval, no cron, no game-loop
thread. The room schedules a `tick` reminder, the reminder
delivers a `tell`, the tell runs the `tick` handler under the
mailbox's serial-write guarantee, the handler reschedules itself
if any entity is still moving. That's the entire "realtime"
layer — Akka, Erlang, and actjs all do real-time games this
way.

By the end of this chapter you will:

- Have an A\* pathfinder that operates on `RoomState.tiles`.
- Have a player entity stored inside `RoomState.entities`, drawn
  by the renderer as `@`.
- Have a `move` handler that runs A\* on the server and stashes
  the result.
- Have a self-scheduled `tick` handler that advances every
  moving entity one tile per call, then re-arms itself.
- Have a click handler in the browser that POSTs to `move` and
  polls `read` until the player stops moving.

## Why the tick handler is a reminder, not a setInterval

This is the central design question of realtime in an actor
framework. The wrong answer is "spin up a setInterval somewhere
that pokes the room every 200 ms." The right answer is "the
room sends itself a reminder."

Why?

- **A setInterval lives outside the mailbox.** If the timer
  fires while a handler is running, the timer callback might
  observe half-updated state. The whole point of single-writer
  semantics is that doesn't happen.
- **A setInterval doesn't survive a server restart.** When the
  process restarts, the timer is gone; you have to remember to
  re-arm it. The reminder is durable — it's written to the
  storage driver and replayed on the next process boot.
- **A setInterval ticks even when no one's playing.** A room
  with no moving entities should consume zero CPU. Reminders
  only fire when scheduled; if nothing schedules them, the
  actor sleeps.

The reminder pattern composes naturally: any actor that needs a
"tick" of any kind — animation, AI, expiry, cooldown — schedules
itself. We'll use the same primitive for monster AI (ch 11) and
respawn timers (ch 14) without any new infrastructure.

## A\* pathfinding

Pathfinding is a pure server-side function. It takes the room's
tile grid, a start, and a goal; returns the shortest sequence of
tiles to walk. Put it in its own file so the room logic stays
focused.

Create `src/pathfinding.ts`:

```ts
export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface RoomGrid {
  readonly width: number;
  readonly height: number;
  readonly tiles: readonly string[];
}

/** Floor and doors are walkable; walls aren't. */
export function isPassable(grid: RoomGrid, p: Point): boolean {
  if (p.x < 0 || p.x >= grid.width) return false;
  if (p.y < 0 || p.y >= grid.height) return false;
  const ch = grid.tiles[p.y]?.[p.x];
  return ch === '.' || ch === '+';
}

/**
 * 4-neighbor A* with Manhattan heuristic. Returns the sequence
 * of tiles to step through, excluding `start`. Empty array means
 * "no path" or "already there."
 *
 * The grid is small (20×20 = 400 cells), so we use a Map as the
 * open set with a linear-scan min lookup. A heap would be faster
 * asymptotically but invisible at this scale.
 */
export function findPath(grid: RoomGrid, start: Point, goal: Point): Point[] {
  if (!isPassable(grid, goal)) return [];
  if (start.x === goal.x && start.y === goal.y) return [];

  const key = (p: Point) => `${p.x},${p.y}`;
  const heur = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

  interface Node {
    readonly p: Point;
    readonly g: number;
    readonly f: number;
    readonly parent: Node | null;
  }

  const startNode: Node = { p: start, g: 0, f: heur(start, goal), parent: null };
  const open = new Map<string, Node>([[key(start), startNode]]);
  const closed = new Set<string>();

  while (open.size > 0) {
    // Pop the node with the lowest f-score.
    let bestKey = '';
    let best: Node | null = null;
    for (const [k, node] of open) {
      if (!best || node.f < best.f) {
        bestKey = k;
        best = node;
      }
    }
    if (!best) break;

    if (best.p.x === goal.x && best.p.y === goal.y) {
      const path: Point[] = [];
      let cur: Node | null = best;
      while (cur && cur.parent !== null) {
        path.unshift(cur.p);
        cur = cur.parent;
      }
      return path;
    }

    open.delete(bestKey);
    closed.add(bestKey);

    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const np: Point = { x: best.p.x + dx, y: best.p.y + dy };
      const nk = key(np);
      if (closed.has(nk)) continue;
      if (!isPassable(grid, np)) continue;
      const g = best.g + 1;
      const existing = open.get(nk);
      if (existing && existing.g <= g) continue;
      open.set(nk, { p: np, g, f: g + heur(np, goal), parent: best });
    }
  }
  return [];
}
```

Three things worth pausing on:

- **Drunkard's walk guarantees connectivity** (chapter 03), so
  `findPath` between any two floor tiles in the same room always
  returns a non-empty path. The "no path" case fires only when
  the click lands on a wall — which `isPassable(grid, goal)`
  catches before A\* even starts.
- **The path excludes the start.** If the player is at `(5, 5)`
  and clicks `(7, 5)`, the returned path is `[(6, 5), (7, 5)]` —
  two steps to consume. This makes the tick loop trivial: shift
  the front, move the entity there.
- **No diagonals.** 4-neighbor movement only. Diagonal A\* is a
  one-line change (add the four diagonal deltas with a cost of
  `Math.SQRT2`) but the renderer would have to interpolate
  between cardinal frames; not worth the complexity for the
  tutorial.

## The Room rewrite

Chapter 02 declared `RoomState` with `readonly` modifiers, which
was a defensive default for read-only handlers. Now we need to
mutate — the room owns moving entities and a tick flag. Loosen
the type and add the new fields.

Edit `src/room.ts`:

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
  /** Stable identifier within the room. v1: just 'player'. */
  id: string;
  x: number;
  y: number;
  /** Remaining path steps. Empty = not moving. */
  path: Point[];
}

export interface RoomState {
  width: number;
  height: number;
  seed: number;
  tiles: string[];
  entities: Entity[];
  /** True iff a `tick` reminder is already scheduled. */
  tickScheduled: boolean;
}

export class Room extends Actor<RoomState> {
  override onInit(): void {
    const seed = hashStringToSeed(this.actor_id as string);
    const tiles = drunkardsWalk({ width: WIDTH, height: HEIGHT, seed });
    const start = findFirstFloor(tiles);
    this.state = {
      width: WIDTH,
      height: HEIGHT,
      seed,
      tiles,
      entities: [{ id: 'player', x: start.x, y: start.y, path: [] }],
      tickScheduled: false,
    };
  }

  @handler('read')
  read(): RoomState {
    return this.state;
  }

  @handler('move')
  async move(args: { x: number; y: number }): Promise<{ pathLength: number }> {
    const player = this.state.entities.find((e) => e.id === 'player');
    if (!player) throw new Error('no player in this room');
    const grid = {
      width: this.state.width,
      height: this.state.height,
      tiles: this.state.tiles,
    };
    if (!isPassable(grid, { x: args.x, y: args.y })) {
      // Click landed on a wall (or off the grid). No path; no error.
      player.path = [];
      return { pathLength: 0 };
    }
    player.path = findPath(grid, { x: player.x, y: player.y }, { x: args.x, y: args.y });
    if (player.path.length > 0) await this.ensureTickRunning();
    return { pathLength: player.path.length };
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

function findFirstFloor(tiles: readonly string[]): { x: number; y: number } {
  for (let y = 0; y < tiles.length; y++) {
    const row = tiles[y]!;
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '.') return { x, y };
    }
  }
  // Drunkard's walk always carves something, so this should be
  // unreachable. Fall back to (1, 1) just to be safe.
  return { x: 1, y: 1 };
}
```

The four changes that matter:

1. **`RoomState.entities`** lists every entity currently in the
   room. Chapter 02–04 had no entities; the player has been
   imaginary until now. `onInit` spawns one at the first floor
   tile it finds, with an empty path.
2. **`RoomState.tickScheduled`** is the "is the tick loop
   running" flag. `ensureTickRunning` is the only place that
   sets it to `true`; `tick` is the only place that sets it
   back to `false`. The pattern matters because if `move` is
   called twice in quick succession, we don't want two
   `scheduleAt` calls racing for the same `tick` slot.
3. **`move`** runs A\* and stores the result on the player's
   `path`. If the click landed on a wall it does nothing (path
   becomes empty); we can refine to a structured 400 error in
   chapter 12 when policy decisions arrive. For now, silent
   no-op is fine.
4. **`tick`** is the heart of the realtime loop. Every entity
   with a non-empty path consumes one step; if any entity still
   has steps remaining, the tick reschedules itself for another
   `TICK_MS` from now.

The self-scheduling line in `ensureTickRunning` is the chapter's
key concept:

```ts
await this.actjs!.scheduleAt(this.actjs!.now() + TICK_MS, 'tick', {});
```

`this.actjs.scheduleAt(when, type, payload)` is the actjs
primitive for "send a tell of `type` to myself at time
`when`." The tell goes through the mailbox like any other —
which is exactly what we want.

## Browser updates

The renderer needs three changes:

1. Draw entities on top of tiles (entity layer).
2. Translate clicks into tile coordinates and POST to `/move`.
3. Poll `/read` while the player is moving.

Replace `public/main.js` with:

```js
const TILE = 24;
const POLL_MS = 200;

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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

const mintRoom = () => rpc('/v1/actors/Room').then((r) => r.id);
const readRoom = (id) => rpc(`/v1/actors/Room/${id}/read`).then((r) => r.result);
const moveTo = (id, x, y) => rpc(`/v1/actors/Room/${id}/move`, { x, y });

function render(canvas, room) {
  canvas.width = room.width * TILE;
  canvas.height = room.height * TILE;
  const ctx = canvas.getContext('2d');
  ctx.font = `${Math.floor(TILE * 0.7)}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Pass 1: tiles.
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
  // Pass 2: entities (drawn on top of their tile).
  for (const e of room.entities) {
    const style = ENTITY_STYLES[e.id] ?? UNKNOWN_ENTITY;
    ctx.fillStyle = style.color;
    ctx.fillText(style.glyph, e.x * TILE + TILE / 2, e.y * TILE + TILE / 2);
  }
}

let pollHandle = null;
async function startPollingUntilStill(id, canvas) {
  if (pollHandle) return;
  pollHandle = setInterval(async () => {
    const room = await readRoom(id);
    render(canvas, room);
    if (!room.entities.some((e) => e.path.length > 0)) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }, POLL_MS);
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
  let room = await readRoom(id);
  render(canvas, room);

  canvas.addEventListener('click', async (event) => {
    const rect = canvas.getBoundingClientRect();
    const tx = Math.floor((event.clientX - rect.left) / TILE);
    const ty = Math.floor((event.clientY - rect.top) / TILE);
    const result = await moveTo(id, tx, ty);
    if (result.result.pathLength > 0) {
      await startPollingUntilStill(id, canvas);
    }
  });
}

main().catch((err) => {
  document.body.innerHTML = `<pre style="color:#f55;padding:1rem">${err.stack}</pre>`;
});
```

A few notes:

- **Two-pass rendering.** Tiles first (a full repaint of the
  grid), then entities drawn on top. There's no flicker because
  `<canvas>` is synchronous within a frame.
- **`pollHandle` is the polling loop.** We start it on click and
  stop it when no entity has a remaining path. **This is the
  pattern chapter 06 replaces.** Polling at 200 ms is cheap on
  the LAN and unconscionable on the public internet; the WS
  subscription drops the latency _and_ halves the bandwidth.
- **`ENTITY_STYLES['player'] = { glyph: '@', color: '#fff' }`.**
  Classic roguelike `@`. Future entities (merchant, rat) extend
  this dictionary; the renderer doesn't change.

## Run it

```bash
pnpm dev
```

Open `http://localhost:3000/`. You should see the dungeon with
a white `@` somewhere on the carved region. Click a floor tile.
The `@` walks toward it, one tile every 200 ms.

Try a few:

- **Click far across the room.** A\* finds the shortest path
  through the cave; the player traces it.
- **Click on a wall.** Nothing happens. The server returns
  `pathLength: 0`; the browser doesn't start polling.
- **Click mid-move.** The path changes. The next tick consumes
  the first step of the _new_ path.
- **Click the door (`+`).** The player walks onto the door tile
  (doors are passable). It stops there because there's no next
  room to enter — that arrives in chapter 09.

## Look closely: what's polling actually costing us

Open the Network panel. Click somewhere. You'll see a `move`
POST followed by a stream of `read` POSTs, one every 200 ms
until the player stops. For a 12-step path that's 13 requests
(1 move + 12 reads). For a long walk across the room it's
20 reads.

Each `read` round-trips the entire `RoomState` object — the
400-character tile grid, the full entities list, the
tickScheduled flag. Most of that is byte-identical to the
previous response; we're paying for one entity's `(x, y)` move
by sending the whole room.

This is the polling tax. Chapter 06 introduces the WS
subscription which:

- Opens one socket, multiplexes every actor subscription on it
  (no per-room socket).
- Sends the full snapshot once.
- Sends only RFC 6902 **patches** for subsequent state
  changes. A one-tile move becomes a 30-byte diff instead of a
  500-byte snapshot.
- Pushes from server to client, so the 200 ms tick rate is the
  natural delivery cadence — no client-side timer to tune.

We won't pretend ch 05 already has this. Until chapter 06 lands
the polling is the deal. But knowing why is half the lesson.

## Commit + tag

```bash
git add .
git commit -m "ch05: A* + tick reminder loop + click-to-move"
git tag ch05-done
```

## Recap

| New concept                           | Where it lives                                |
| ------------------------------------- | --------------------------------------------- |
| Self-scheduled `tick` reminder        | `Room.ensureTickRunning`                      |
| Mutating `this.state` inside handlers | `Room.move`, `Room.tick` (entity x/y updates) |
| Entity layer on top of tile layer     | `render()` two-pass loop in `main.js`         |
| Click → tile coordinates → RPC        | `canvas.addEventListener('click', ...)`       |
| Server-authoritative pathfinding      | `findPath()` in `pathfinding.ts`              |

What you didn't have to do:

- Run a game-loop thread or `setInterval` on the server.
- Coordinate between the move handler and the tick handler — the
  mailbox serializes them automatically.
- Worry about the tick firing while a `move` handler is running
  — it can't, by the SWM invariant.
- Make pathfinding "transactional" with state — every handler
  turn is its own implicit transaction; the snapshot after the
  turn is the committed state.

The room actor is now a tiny game loop. We'll layer more onto
it (mobs in ch 11, room transitions in ch 08) but the
self-scheduling tick pattern is fixed: schedule, tick, advance,
re-schedule.

## What's next

**Chapter 06 — Subscriptions: stop polling** is the immediate
sequel. The browser drops `setInterval` and opens a WebSocket;
the server pushes RFC 6902 patches at tick rate. The room
actor's handler code doesn't change at all — actjs's
subscription machinery picks up state mutations automatically.

After that, **chapter 07 — Player actor** promotes the
`'player'` entity from a room-state record into its own
`Player` actor, which is what enables per-browser identity and
real multi-player. The tick handler stays the same; we just
gain the ability for the room to know "this entity belongs to
player Alice; the one over there belongs to player Bob."

---

## Troubleshooting

**`Cannot read properties of undefined (reading 'tiles')`**

Old `?id=…` URL pointing at a room that doesn't have the new
state shape. The chapter 03 `RoomState` had no `entities`; if
you reload an old room id with the chapter 05 renderer, the
entities loop bombs. Clear the URL (`?` link) and let the page
mint a fresh room.

**Click is offset from where I clicked**

Most likely cause: the canvas has CSS scaling on it. The
chapter's `index.html` doesn't apply any, but if you added a
`max-width: 100%` rule the canvas's `clientWidth` won't equal
its `width` attribute. The fix: drop the CSS rule, or scale
the click coords by `canvas.width / rect.width`.

**Player teleports instead of walking**

Both your tabs are polling the same room. They're seeing
each other's snapshot updates, which is what you'd expect.
The "teleport" appearance is one tab's renderer catching up
to a state the other tab caused. Chapter 06's subscription
contract is smoother (every tab sees the same patches in the
same order); for ch 05 the cosmetic stutter is a known
limitation.

**Player walks through walls**

You probably forgot to gate `move` on `isPassable(grid, args)`,
or your `isPassable` check considers `#` walkable. Double-check
the `ch === '.' || ch === '+'` line.

**`scheduleAt` complains the actjs bridge is undefined**

`this.actjs` is set by the runtime on activation. If you're
calling `Room.tick()` directly from a unit test (without the
`TestRuntime` harness), the bridge is undefined. Use
`@jplevyak/actjs/test`'s `TestRuntime` for unit tests — see
`docs/testing.md`. The runtime sets `this.actjs` correctly
inside `TestRuntime`.

**Two clicks land at the same time and the player makes a
weird zig-zag**

Each click replaces the path. The mailbox serializes the two
`move` calls; whichever wins last decides the final path.
That's by design — there's no "queue clicks" UX in any
roguelike I know of. If you want queueing, you'd add a
`queuedDestination` field on the entity and consume it when
the current path empties.
