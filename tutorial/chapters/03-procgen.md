# Chapter 03 — Procgen on `onInit`

> **Chapter goal:** swap the hand-coded 20×20 box from chapter 02
> for a procedurally generated dungeon room. Procgen happens
> exactly once per actor lifetime, inside `onInit`. The dungeon
> is deterministic — the same actor id always materializes the
> same room.
>
> **Time budget:** ~45 minutes.
>
> **End-of-chapter tag:** `ch03-done`.

---

Two chapters in we have a working `Room` actor, but every room is
identical: walls around the edge, floor in the middle, single door
north. This chapter makes each room look like a real dungeon —
random, but reproducibly random. Same actor id → same dungeon,
forever.

By the end of this chapter you will:

- Have replaced the static room layout with a drunkard's-walk
  procgen pass.
- Understand the **frozen-after-generation invariant** — why
  procgen lives in `onInit` and not in a handler.
- See how `Actor.actor_id` is used inside an actor as the
  deterministic seed source.
- Have hit a side-quest: a small seedable PRNG, the cheapest
  ~10-line tool that converts "I want this to be reproducible"
  into "I have a reproducible source of randomness."

## Why `onInit` is the right place

actjs gives you three hooks where state can be initialized:

| Hook         | When it fires                              | How often      |
| ------------ | ------------------------------------------ | -------------- |
| `onInit`     | First materialization (no snapshot exists) | **Once**, ever |
| `onActivate` | Every materialization, cold or warm        | Many times     |
| (handler)    | Whenever the wire calls it                 | Many times     |

Procgen belongs in `onInit` because it's the only place that
runs **exactly once** per actor lifetime. The first time the room
materializes, the algorithm runs and the result lands in
`state.tiles`. After the snapshot debounce flushes, the dungeon
is durable. Every subsequent activation — for instance, after
the actor goes idle and gets evicted, then comes back when a
handler call arrives — loads the persisted snapshot and skips
`onInit` entirely.

That's the **frozen-after-generation invariant**. It's why
procgen-as-pure-function works cleanly in actjs: you generate
the output once, snapshot it, and from then on the dungeon is
just data. No regeneration race, no "did this room get
regenerated yet?" check, no caching layer between procgen and
state.

If you put procgen in a handler instead, every call would
re-roll the dungeon. If you put it in `onActivate`, every server
restart would re-roll. Both are wrong shapes for "the dungeon
exists once and stays."

> **Sidebar — escape valve.** With the in-memory driver every
> server restart loses your dungeon, which is annoying once
> you've grown attached to one. Chapter 18 graduates to the PG
> driver in a 3-line change; if you're impatient, you can do the
> swap now and come back here. For everyone else, restarts
> producing fresh dungeons is part of the lesson — onInit fires
> on the first materialization, not on activation.

## A 10-line seedable PRNG

`Math.random()` isn't seedable. We need a tiny pseudo-random
function that returns the same sequence for the same seed.
`mulberry32` is the canonical 5-line answer: small state, fast,
plenty good for game-grade randomness.

Add `src/rng.ts`:

```ts
/**
 * Seedable PRNG. Returns a function that produces a stream of
 * floats in `[0, 1)`. Same seed → identical sequence.
 *
 * This is `mulberry32`. It's tiny, fast, and not
 * cryptographically secure — perfect for procgen, useless for
 * tokens.
 */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hash a string into a 32-bit integer suitable as a `mulberry32`
 * seed. Used to derive a per-actor seed from `actor_id`.
 *
 * This is the FNV-1a hash, also ~5 lines and good enough.
 */
export function hashStringToSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}
```

Two utilities, ten meaningful lines of code. We won't touch
this file again.

## Drunkard's walk

Add `src/procgen.ts`:

```ts
import { mulberry32 } from './rng.js';

export interface ProcgenOpts {
  readonly width: number;
  readonly height: number;
  readonly seed: number;
  /** How many tiles to carve. Higher = more open. */
  readonly steps?: number;
}

/**
 * Drunkard's-walk room generator.
 *
 * Start with all walls. Drop a "drunkard" at the center; on each
 * step, carve the current tile to floor and move one square in a
 * random cardinal direction. After `steps` iterations, return
 * the grid as 20 strings of length 20.
 *
 * Properties worth knowing:
 *   - The carved region is *always* connected (the walker can't
 *     teleport, so every floor tile is reachable from the start).
 *   - Borders are inviolate: walls around the edge stay walls, so
 *     callers can rely on `tiles[0]` and `tiles[h-1]` being
 *     all-wall and place doors deterministically.
 *   - Visually random, parameter-light, ~20 lines.
 */
export function drunkardsWalk(opts: ProcgenOpts): string[] {
  const { width, height, seed } = opts;
  const steps = opts.steps ?? Math.floor(width * height * 1.25);
  const rng = mulberry32(seed);

  // Grid starts as all walls.
  const grid: string[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => '#'),
  );

  // Walker starts at center.
  let x = Math.floor(width / 2);
  let y = Math.floor(height / 2);

  for (let i = 0; i < steps; i++) {
    // Carve at the current position, but never on the border.
    if (x > 0 && x < width - 1 && y > 0 && y < height - 1) {
      grid[y]![x] = '.';
    }
    // Step one square in a random cardinal direction.
    const dir = Math.floor(rng() * 4);
    if (dir === 0) x++;
    else if (dir === 1) x--;
    else if (dir === 2) y++;
    else y--;
    // Keep the walker in bounds (bounce off interior walls).
    x = Math.max(1, Math.min(width - 2, x));
    y = Math.max(1, Math.min(height - 2, y));
  }

  // Stamp a door at the top-center so future rooms can connect
  // (chapter 09 wires the graph; for now the door is decorative).
  const doorX = Math.floor(width / 2);
  grid[0]![doorX] = '+';

  return grid.map((row) => row.join(''));
}
```

Two notes on the algorithm:

- **`steps = width * height * 1.25` by default.** Drunkard's walks
  revisit themselves a lot — at this rate, ~30–35% of tiles get
  carved to floor, which feels cave-shaped without filling the
  grid. Halve it to get sparser corridors; double it to get
  near-empty rooms.
- **Drunkard's walk produces a single connected region.** That
  matters in chapter 05 when we run A\* pathfinding: every floor
  tile is guaranteed reachable from every other floor tile, so
  the pathfinder doesn't need a "no path exists" case for the
  same-room scenario. Different procgen algorithms (cellular
  automata, BSP) need a connectivity pass; drunkard's walk
  doesn't.

Other approaches — BSP, rooms-and-corridors, cellular automata,
Wave Function Collapse — are richer and produce more
recognizably "dungeon-shaped" output. See the **Further reading**
appendix at the bottom of this chapter. For the tutorial we want
the algorithm to disappear so we can focus on the framework
hooks around it.

## Wire it into `Room.onInit`

Edit `src/room.ts`. The state shape and handlers don't change;
only `onInit`:

```ts
import { Actor } from 'actjs/actor';
import { handler } from 'actjs/handler';

import { drunkardsWalk } from './procgen.js';
import { hashStringToSeed } from './rng.js';

const WIDTH = 20;
const HEIGHT = 20;

export interface RoomState {
  readonly width: number;
  readonly height: number;
  readonly seed: number;
  readonly tiles: readonly string[];
}

export class Room extends Actor<RoomState> {
  override onInit(): void {
    // Derive a deterministic seed from the actor id. UUIDv7s are
    // distinct, so each fresh actor gets its own dungeon; the
    // *same* actor id always reproduces the same dungeon.
    const seed = hashStringToSeed(this.actor_id as string);
    this.state = {
      width: WIDTH,
      height: HEIGHT,
      seed,
      tiles: drunkardsWalk({ width: WIDTH, height: HEIGHT, seed }),
    };
  }

  @handler('read')
  read(): RoomState {
    return this.state;
  }

  @handler('tileAt')
  tileAt(args: { x: number; y: number }): string {
    const row = this.state.tiles[args.y];
    if (!row || args.x < 0 || args.x >= this.state.width) {
      throw new Error(`out of bounds: (${args.x}, ${args.y})`);
    }
    return row[args.x] ?? '?';
  }
}
```

A few specifics worth noticing:

- **`this.actor_id`** is set by the runtime on activation, before
  `onInit` runs. It's the canonical "who am I?" inside the
  actor. (In chapter 11 the BYO auth principal arrives via a
  different channel; `actor_id` is always the actor's own id.)
- **`actor_id as string`** — `ActorId` is a branded type. The
  PRNG hash takes a plain `string`, so we have to widen. This
  is one of the few times you'll see an `as string` in this
  tutorial.
- **`seed` is stored in `state`.** Costs four bytes; gives the
  reader an easy "what was this dungeon's seed?" answer when
  inspecting a JSON snapshot. Optional — comment out if you
  prefer minimal state.
- **`buildEmptyRoom` is gone.** Procgen is the only path now.

## Run it

```bash
pnpm dev
```

Mint a fresh room and read it:

```bash
ID=$(curl -s -X POST http://localhost:3000/v1/actors/Room \
  -H 'content-type: application/json' \
  -d '{}' | jq -r .id)

curl -s -X POST http://localhost:3000/v1/actors/Room/"$ID"/read \
  -H 'content-type: application/json' \
  -d '{}' | jq -r '.result.tiles[]'
```

You should see a meandering cave-like region — something along
the lines of:

```
##########+#########
########...#......##
########.#.#......##
######............##
######.#...........#
#####..............#
#####..............#
######...........###
####..............##
########.........###
######.......##..###
######...#..####..##
######.....#####.###
######..#..#########
######....##########
#######.############
####################
####################
####################
####################
```

Walls (`#`) dominate where the walker never went; floor (`.`)
traces the walker's path; door (`+`) at the top. Your dungeon
will look different — the layout is reproducible from your
actor id, not mine.

Note that the door at the top is currently decorative — the
walker didn't necessarily reach the top edge, so the `+` may
sit on an island of wall. Chapter 09 (when the dungeon graph
arrives) will replace this with door tiles that actually
connect to neighboring rooms.

## Determinism, two ways

**Same actor id → same dungeon.** Re-read the same room any
number of times and you get byte-identical output:

```bash
curl -s -X POST http://localhost:3000/v1/actors/Room/"$ID"/read \
  -H 'content-type: application/json' \
  -d '{}' | jq -r '.result.tiles[]' | md5sum

# (a second time)
curl -s -X POST http://localhost:3000/v1/actors/Room/"$ID"/read \
  -H 'content-type: application/json' \
  -d '{}' | jq -r '.result.tiles[]' | md5sum
```

The two checksums match. The first call materialized the room
and ran `onInit`; the second call hit a live host with the
state already populated. The third, fourth, and Nth calls do
the same. The snapshot, once written, freezes the layout.

**Different actor ids → different dungeons.** Mint a couple
more and confirm they're not the same:

```bash
for i in 1 2 3; do
  ID=$(curl -s -X POST http://localhost:3000/v1/actors/Room \
    -H 'content-type: application/json' -d '{}' | jq -r .id)
  echo "=== $ID ==="
  curl -s -X POST http://localhost:3000/v1/actors/Room/"$ID"/read \
    -H 'content-type: application/json' -d '{}' \
    | jq -r '.result.tiles | (.[5], .[10])'  # rows 5 and 10
done
```

Three different actor ids; three different mid-room layouts.
The `seed` field in each room's state is a 32-bit integer
derived from the id, so two distinct ids almost certainly map
to two distinct seeds (collisions are possible but rare).

> **What about a "give me a dungeon with seed 42" demo?** Today
> the seed isn't reader-controllable — it's derived from the
> actor id, which the server mints. A future chapter could add
> a `regenerate({seed})` handler if controllable seeding is
> important; the tutorial doesn't need it, and chapter 09's
> dungeon-graph generator will give us the explicit-seed story
> at a higher level.

## What just got snapshotted

Out of curiosity, peek at the raw snapshot for one of those
rooms:

```bash
sleep 1   # give the 250 ms debounce time to flush
curl -s http://localhost:3000/v1/actors/Room/"$ID" | jq '.state.seed, (.state.tiles | length)'
# → 1572983014    (or whatever your hash was)
# → 20
```

The `seed` is part of the durable snapshot. If you killed the
server and brought it back with a PG driver (ch 18), this same
`seed` would re-emerge — and crucially, **`onInit` would not
re-run** because the snapshot already exists. The dungeon is
frozen.

That's the invariant. Once snapshotted, the room is data.

## Commit + tag

```bash
git add .
git commit -m "ch03: drunkard's walk procgen in Room.onInit"
git tag ch03-done
```

## Recap

Three new concepts, in order of importance:

1. **The frozen-after-generation invariant.** Procgen runs in
   `onInit`, which fires exactly once per actor lifetime. After
   that, the room is durable state. No regeneration, no caching
   layer, no race.
2. **Seed from `actor_id`.** Per-actor determinism without a
   seed argument on the wire. Same id → same dungeon, every
   time.
3. **Tiny utilities.** A seedable PRNG and a string hash are
   each five lines of code and enable everything else. Not a
   framework concern — actjs has nothing to say about either
   — but they're the kind of plumbing every game needs.

What you didn't have to do:

- Cache the procgen output. (`onInit` runs once; the snapshot is
  the cache.)
- Handle the "did this room get regenerated?" race. (Snapshots
  are the single source of truth.)
- Add a database table for "rooms I've already generated."
  (The `actor_snapshot` table already is that table.)

## What's next

**Chapter 04 — Browser renderer** finally makes the dungeon
visible. A static HTML page with a `<canvas>`, a glyph map
(`#` → ▓, `.` → ·, `+` → ▒, `@` → 🧙), a tiny Fastify static
route, and 50-ish lines of canvas code. By the end of ch 04
you'll be looking at your dungeon in a browser instead of a
terminal.

---

## Further reading: other procgen algorithms

Drunkard's walk is short and works. The other classics in
roguelike circles:

- **Cellular automata.** Initialize a grid randomly (~45% walls),
  then run "smoothing" passes where each tile becomes wall or
  floor based on a count of its neighbors. Produces big open
  caverns. Needs a connectivity pass — the output can have
  disconnected pockets. See
  [Generating Random Cave-Like Levels Using Cellular Automata](https://web.archive.org/web/20210501221636/https://www.roguebasin.com/index.php/Cellular_Automata_Method_for_Generating_Random_Cave-Like_Levels)
  (RogueBasin).
- **BSP (binary space partitioning).** Recursively split a
  rectangle into rooms, then connect adjacent rooms with
  corridors. Produces square-room, right-angle-corridor
  layouts that look like classical roguelike dungeons. More
  setup, more knobs. See Bob Nystrom's
  [Rooms and Mazes](https://journal.stuffwithstuff.com/2014/12/21/rooms-and-mazes/).
- **Rooms + corridors.** Place N rectangles of random size on
  the grid, connect each to the next with an L-shaped corridor.
  Simpler than BSP, less visually structured but easy to tune.
- **Wave Function Collapse.** Tile-based constraint solver.
  Excellent results, much more code. Overkill for a tutorial
  but worth knowing exists.

Swapping `drunkardsWalk` for any of these is a single-line
change at the `onInit` call site. The framework hooks around
procgen — `onInit`, the snapshot, the actor id as seed — stay
the same. That's the design lesson: actjs doesn't care which
algorithm you use, only that you put it in the right hook.

---

## Troubleshooting

**Every room looks identical**

`mulberry32(0)` and `mulberry32(1)` produce visibly different
sequences. If every room comes out the same, you're probably
calling the PRNG with the same seed each time. Check that
`this.actor_id` is being used (and not, say, a hardcoded
constant or `Date.now()`).

**Rooms come back as a single floor tile**

You probably passed `steps: 1` (or didn't pass `steps` and
hit a typo'd default). The default `width * height * 0.4` =
160 for a 20×20 grid; less than ~30 produces visibly sparse
results.

**`this.actor_id is undefined`**

`actor_id` is set just before `onInit` runs, but only when the
actor is materialized through the runtime. If you're
instantiating `Room` directly in a test (`new Room()`), you
need to assign `actor_id` manually. The recommended path for
that is `@actjs/test`'s `TestRuntime` (see `docs/testing.md`),
which handles activation properly.

**Server restart and the dungeon is different**

That's the memory driver doing its job — restart loses every
snapshot. Chapter 18 graduates to PG, where snapshots
persist. In the meantime, restarting is how you get a fresh
dungeon to play with.
