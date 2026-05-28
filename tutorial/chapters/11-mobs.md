# Chapter 11 — Mobs as room-state

> **Chapter goal:** add wandering, chasing, biting monsters to
> the dungeon — without writing a single new actor class. Mobs
> live as state inside the room actor; the room's tick handler
> grows AI + combat logic; every turn is one atomic mutation.
> The interlude predicted this; chapter 11 makes it concrete.
>
> **Time budget:** ~80 minutes.
>
> **End-of-chapter tag:** `ch11-done`.

---

Chapter 10 made the case that a merchant is its own actor —
identity outlives any room, inventory is shared across
locations, contended writes need the mailbox as a lock. This
chapter makes the deliberate opposite case. Rats stay as records
inside `Room.state.entities`. We don't write a `Mob` actor
class.

The interlude's checklist explains why:

| Question                              | Merchant | Rat                                          |
| ------------------------------------- | -------- | -------------------------------------------- |
| Serial writes for correctness?        | yes      | **no** (only the room's tick handler writes) |
| Lifetime independent of any parent?   | yes      | **no** (rats are bound to their room)        |
| Subscription target for other actors? | yes      | **no** (no one subscribes to a single rat)   |

Three nos. The interlude's framework predicts: **state inside a
parent actor**, not its own actor.

The payoff: every per-room turn — player movement, mob AI,
combat resolution, death cleanup, door transitions — runs in
one mailbox turn. One atomic mutation. No saga across actors,
no compensation, no inconsistency window. The same single-
writer-mailbox property we've been getting for free since
chapter 02.

By the end of this chapter you will:

- Have an `Entity.type = 'mob'` variant with `hp`, `maxHp`, and
  `damage`.
- Have mob spawning in `Room.onInit` — deterministic per room,
  two or three rats placed on random floor tiles.
- Have a `Room.tick` handler that runs mob AI (chase nearest
  player or wander), resolves bump-attacks in both directions,
  applies damage, removes dead mobs, respawns dead players.
- Have a renderer that draws mobs with a red `r` glyph + an HP
  display in the header.
- Have the deliverable: rats patrol; they bite; sometimes you
  kill them; sometimes they kill you and you respawn at the
  spawn point.

## Why this isn't a `Mob` actor class

Worth pausing on, because it's the chapter's load-bearing
design decision. If you've been reading carefully you might
expect a `Mob extends Actor<MobState>` class — they're
characters, they have HP, they "act" on a timer. That's not
the actjs-shaped answer.

Imagine you'd written it. Every tick:

1. The room iterates its mobs.
2. For each mob, the room makes a cross-actor `call` to ask:
   "where do you want to step?"
3. The mob's mailbox processes the call: looks up the room's
   state (another cross-actor call — to read the room), picks
   a target tile, returns.
4. The room applies the step.

With 3 mobs and a tick rate of 200 ms, that's 6 cross-actor
calls per room per tick. With 9 rooms (the 3×3 dungeon from
chapter 09), that's 54 mailbox turns per second per dungeon,
all serialized through individual mob mailboxes that mostly do
nothing.

The room-state version has _one_ mailbox turn per room per tick
that processes everything. The same tick computes all moves,
resolves all attacks, removes all dead — atomically.

This isn't an optimization — it's the right shape. Mobs fail
all three checklist questions; they're _supposed_ to be state.
The simplicity is what you get when you accept the framework's
predictions.

(There's _one_ exception in the bonus catalog: a unique boss
that wanders between rooms. That entity passes question 2
[lifetime outlives any room], so it gets its own actor. Run-
of-the-mill rats don't.)

## Extend `Entity` for combat

Open `src/room.ts` and grow the `Entity` interface:

```ts
export interface Entity {
  id: string;
  type: 'player' | 'merchant' | 'mob';
  displayName: string;
  x: number;
  y: number;
  /** Empty for stationary entities. Mobs use this for chase steps. */
  path: Point[];
  /** Hit points. Merchants always have 0; checked via `type` not `hp`. */
  hp: number;
  maxHp: number;
  damage: number;
}
```

Combat-bearing fields land on every entity. We use `type`, not
`hp`, to decide who participates in combat — that way the
sentinel "merchant has hp = 0" doesn't accidentally read as
"merchant is dead."

While you're in there, update `addEntity` and
`addMerchantPresence` to populate the new fields:

```ts
@handler('addEntity')
async addEntity(args: { playerId: string; displayName: string }): Promise<{
  x: number;
  y: number;
}> {
  const existing = this.state.entities.find((e) => e.id === args.playerId);
  if (existing) return { x: existing.x, y: existing.y };
  this.state.entities.push({
    id: args.playerId,
    type: 'player',
    displayName: args.displayName,
    x: this.state.spawn.x,
    y: this.state.spawn.y,
    path: [],
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
    damage: PLAYER_DAMAGE,
  });
  // Kick off the tick loop if any mobs are present — they need
  // to start moving the moment a player walks in.
  if (this.state.entities.some((e) => e.type === 'mob')) {
    await this.ensureTickRunning();
  }
  return { x: this.state.spawn.x, y: this.state.spawn.y };
}

@handler('addMerchantPresence')
addMerchantPresence(args: {
  merchantId: string;
  displayName: string;
  x: number;
  y: number;
}): { ok: true } {
  const existing = this.state.entities.find((e) => e.id === args.merchantId);
  if (existing) return { ok: true };
  this.state.entities.push({
    id: args.merchantId,
    type: 'merchant',
    displayName: args.displayName,
    x: args.x,
    y: args.y,
    path: [],
    hp: 0,
    maxHp: 0,
    damage: 0,
  });
  return { ok: true };
}
```

Three pieces to call out:

- **`addEntity` is now async.** It awaits `ensureTickRunning`
  if mobs are present, so the player's first activation kicks
  off the simulation loop. Before chapter 11 the tick only
  fired on `move`; now any populated room with mobs ticks
  while a player is present.
- **Constants at the top of the file:** `PLAYER_MAX_HP = 20`,
  `PLAYER_DAMAGE = 3`. Tune to taste; the tutorial values
  produce reasonable kill times against the rat stats below.
- **HP travels per-room.** Walking through a door rejoins the
  new room via `addEntity` and resets HP to `PLAYER_MAX_HP`.
  This is the simplest model; a "HP carries between rooms"
  story would move HP onto the Player actor and have the
  room's `addEntity` read it. Tutorial scope: skip.

## Spawn mobs in `onInit`

Each room generates 2–3 rats at random floor tiles during
generation. Seed the spawn off the room's actor id, same as
the procgen, so a given room is reproducibly populated.

Add to `src/room.ts`:

```ts
import { mulberry32 } from './rng.js';

const PLAYER_MAX_HP = 20;
const PLAYER_DAMAGE = 3;
const RAT_MAX_HP = 3;
const RAT_DAMAGE = 1;
const MOB_SIGHT_RANGE = 6;

function generateMobs(seed: number, tiles: readonly string[]): Entity[] {
  const rng = mulberry32(seed ^ 0xc0ffee); // offset to decorrelate from procgen RNG
  const numRats = 2 + Math.floor(rng() * 2); // 2 or 3 rats
  const mobs: Entity[] = [];
  let attempts = 0;
  while (mobs.length < numRats && attempts < 200) {
    attempts++;
    const x = Math.floor(rng() * tiles[0]!.length);
    const y = Math.floor(rng() * tiles.length);
    if (tiles[y]?.[x] !== '.') continue;
    if (mobs.some((m) => m.x === x && m.y === y)) continue;
    mobs.push({
      id: `rat-${mobs.length}`,
      type: 'mob',
      displayName: 'rat',
      x,
      y,
      path: [],
      hp: RAT_MAX_HP,
      maxHp: RAT_MAX_HP,
      damage: RAT_DAMAGE,
    });
  }
  return mobs;
}
```

Wire it into `onInit`:

```ts
override onInit(): void {
  const seed = hashStringToSeed(this.actor_id as string);
  const tiles = drunkardsWalk({ width: WIDTH, height: HEIGHT, seed });
  const grid = parseRoomId(this.actor_id as string);
  if (grid) installGridDoors(tiles, grid.x, grid.y);
  const spawn = findFirstFloor(tiles);
  const mobs = generateMobs(seed, tiles);
  this.state = {
    width: WIDTH,
    height: HEIGHT,
    seed,
    tiles,
    entities: mobs,
    spawn,
    tickScheduled: false,
  };
}
```

Two design notes:

- **Mobs start populated before any player enters.** The room
  is born with a mob population. They sit idle (no tick is
  scheduled) until the first player joins, at which point
  `addEntity` kicks off the tick.
- **Deterministic per-room.** Same actor id → same mobs. If
  chapter 18 graduates to PG, the room's snapshot persists
  the mobs (so restarting doesn't respawn them); if you stay
  on memory, the rats come back fresh on every server boot.

## The tick handler rewrite

This is the chapter's longest single piece of code. The tick
now has six phases:

1. Compute each entity's intended next step.
2. Resolve bump-attacks (entity tries to move onto an enemy →
   attack instead of moving).
3. Apply pending damage.
4. Move non-attacking entities.
5. Remove dead mobs; respawn dead players at the spawn point.
6. Handle door-step transitions for surviving players.
7. Reschedule if anything's still worth ticking.

Replace `tick`:

```ts
@handler('tick')
async tick(): Promise<void> {
  this.state.tickScheduled = false;

  // Phase 1: Compute intents.
  interface Intent {
    entity: Entity;
    nextPos: Point | null;
  }
  const intents: Intent[] = [];
  for (const e of this.state.entities) {
    if (e.type === 'merchant' || e.hp <= 0) {
      intents.push({ entity: e, nextPos: null });
      continue;
    }
    let nextPos: Point | null = null;
    if (e.type === 'player') {
      nextPos = e.path[0] ?? null;
    } else {
      // type === 'mob'
      nextPos = mobNextStep(e, this.state.entities, this.state.tiles);
    }
    intents.push({ entity: e, nextPos });
  }

  // Phase 2: Resolve attacks. Build a damage list; don't apply
  // damage yet — we want all attacks for this tick to "see"
  // the same pre-tick HP values (so two rats both hit a player
  // with 1 HP each can both register, and the player can take
  // both hits on the same tick).
  const damage: { victimId: string; amount: number }[] = [];
  const moves: { entity: Entity; nextPos: Point }[] = [];
  for (const intent of intents) {
    const { entity, nextPos } = intent;
    if (!nextPos) continue;
    const occupant = this.state.entities.find(
      (other) =>
        other.id !== entity.id &&
        other.x === nextPos.x &&
        other.y === nextPos.y &&
        other.hp > 0,
    );
    if (occupant && isEnemy(entity, occupant)) {
      damage.push({ victimId: occupant.id, amount: entity.damage });
      // The attacker consumes the step but doesn't move.
      if (entity.type === 'player') entity.path.shift();
      continue;
    }
    if (occupant) {
      // Friendly in the way (e.g., player into another player,
      // or rat into rat). Skip the move; consume the step.
      if (entity.type === 'player') entity.path.shift();
      continue;
    }
    // Free to move.
    moves.push({ entity, nextPos });
  }

  // Phase 3: Apply damage.
  for (const d of damage) {
    const victim = this.state.entities.find((e) => e.id === d.victimId);
    if (victim) victim.hp = Math.max(0, victim.hp - d.amount);
  }

  // Phase 4: Apply moves. Door transitions for players are
  // collected here for phase 6.
  const transitions: { entity: Entity; direction: Direction }[] = [];
  for (const m of moves) {
    m.entity.x = m.nextPos.x;
    m.entity.y = m.nextPos.y;
    if (m.entity.type === 'player') {
      m.entity.path.shift();
      const tile = this.state.tiles[m.entity.y]?.[m.entity.x];
      if (tile === '+') {
        const dir = doorDirection({ x: m.entity.x, y: m.entity.y });
        if (dir) transitions.push({ entity: m.entity, direction: dir });
      }
    }
  }

  // Phase 5: Remove dead. Players respawn; mobs despawn.
  const dead = this.state.entities.filter((e) => e.hp <= 0 && (e.type === 'player' || e.type === 'mob'));
  for (const d of dead) {
    this.state.entities = this.state.entities.filter((e) => e.id !== d.id);
    if (d.type === 'player') {
      this.state.entities.push({
        ...d,
        x: this.state.spawn.x,
        y: this.state.spawn.y,
        hp: d.maxHp,
        path: [],
      });
    }
  }

  // Phase 6: Door transitions (chapter 08's saga, now after
  // combat).
  for (const t of transitions) {
    // The player must still be alive — if they died this tick,
    // they've already been respawned at the spawn point above.
    const alive = this.state.entities.find((e) => e.id === t.entity.id);
    if (!alive || alive.hp <= 0) continue;
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

  // Phase 7: Reschedule. Keep ticking if any player is in the
  // room (so mobs continue to act), or if anyone has a remaining
  // path step.
  const hasPlayer = this.state.entities.some((e) => e.type === 'player' && e.hp > 0);
  const hasMob = this.state.entities.some((e) => e.type === 'mob' && e.hp > 0);
  const anyMoving = this.state.entities.some((e) => e.path.length > 0);
  if ((hasPlayer && hasMob) || anyMoving) await this.ensureTickRunning();
}

function isEnemy(a: Entity, b: Entity): boolean {
  if (a.type === 'mob' && b.type === 'player') return true;
  if (a.type === 'player' && b.type === 'mob') return true;
  return false;
}

function mobNextStep(mob: Entity, entities: readonly Entity[], tiles: readonly string[]): Point | null {
  // Find the nearest living player.
  const players = entities.filter((e) => e.type === 'player' && e.hp > 0);
  if (players.length === 0) return wanderStep(mob, tiles);
  let nearest = players[0]!;
  let bestD = manhattan(nearest, mob);
  for (const p of players) {
    const d = manhattan(p, mob);
    if (d < bestD) {
      bestD = d;
      nearest = p;
    }
  }
  // Out of sight — wander.
  if (bestD > MOB_SIGHT_RANGE) return wanderStep(mob, tiles);
  // Chase. A* finds the shortest passable path; we take the
  // first step. Pathfinding ignores other entities — they're
  // resolved by the bump-attack logic above.
  const path = findPath(
    { width: WIDTH, height: HEIGHT, tiles },
    { x: mob.x, y: mob.y },
    { x: nearest.x, y: nearest.y },
  );
  return path[0] ?? null;
}

function wanderStep(mob: Entity, tiles: readonly string[]): Point | null {
  const candidates = [
    { x: mob.x + 1, y: mob.y },
    { x: mob.x - 1, y: mob.y },
    { x: mob.x, y: mob.y + 1 },
    { x: mob.x, y: mob.y - 1 },
  ].filter((p) => {
    if (p.x < 0 || p.x >= WIDTH || p.y < 0 || p.y >= HEIGHT) return false;
    const ch = tiles[p.y]?.[p.x];
    return ch === '.' || ch === '+';
  });
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)]!;
}

function manhattan(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}
```

Six things to pause on:

- **The phases are explicitly ordered.** Damage is collected
  in phase 2, applied in phase 3 — so two rats biting a 1-HP
  player both register their hits against the same pre-tick
  HP. Without the deferred apply, the rat that resolved
  second would see the player already dead and skip.
- **The same tick handles both directions of bump-attack.**
  Player walks into rat (player attacks) and rat walks into
  player (rat attacks) are processed in the same loop. No
  ordering bias.
- **Mob pathfinding ignores other entities.** A\* treats them
  as passable. If the chase path runs through a friendly mob
  or another rat, the bump-attack-or-skip logic in phase 2
  handles the collision. Pathfinding's job is just "shortest
  walkable route."
- **Sight range bounds the chase.** Without it, rats would
  chase players across the entire room from the moment a
  player enters. Six tiles is close enough that you can
  outrun rats by walking the long way around — keeps
  gameplay legible.
- **Door transitions after combat.** A player who steps onto
  a door _and_ takes lethal damage this tick respawns at the
  spawn point and doesn't transition. The check at phase 6
  filters out players whose `hp <= 0` (they were already
  respawned via the dead-handling in phase 5).
- **`Math.random()` is fine here.** Wandering is intentionally
  non-deterministic — gives rats personality. If you wanted
  replay (chapter 14 covers event-sourced replay), you'd
  seed a per-room PRNG and store it in `state`.

## Render mobs

The mob entity needs a glyph and color. Edit `public/main.js`:

```js
const MOB_COLOR = '#d44';
const MOB_GLYPH = 'r';

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
    if (e.hp <= 0 && e.type !== 'merchant') continue; // skip dead
    if (e.type === 'merchant') {
      ctx.fillStyle = MERCHANT_COLOR;
      ctx.fillText(MERCHANT_GLYPH, e.x * TILE + TILE / 2, e.y * TILE + TILE / 2);
    } else if (e.type === 'mob') {
      ctx.fillStyle = MOB_COLOR;
      ctx.fillText(MOB_GLYPH, e.x * TILE + TILE / 2, e.y * TILE + TILE / 2);
    } else {
      ctx.fillStyle = colorForPlayer(e.id);
      ctx.fillText('@', e.x * TILE + TILE / 2, e.y * TILE + TILE / 2);
    }
  }
}
```

And surface the player's HP in the header. In `main()`, update
the Room subscription to also write the HP into the header:

```js
roomUnsub = await client.subscribe('Room', newRoomId, (state) => {
  latestRoomState = state;
  render(canvas, state);
  updateBuyButton();
  updateHpDisplay(state, playerId);
});

function updateHpDisplay(state, playerId) {
  const me = state.entities.find((e) => e.id === playerId);
  const hpEl = document.getElementById('hp');
  if (me) {
    hpEl.textContent = `${me.hp} / ${me.maxHp}`;
    hpEl.style.color = me.hp < me.maxHp / 4 ? '#f55' : '#ddd';
  } else {
    hpEl.textContent = '—';
  }
}
```

And add the HP element to `public/index.html`'s header:

```html
<span>HP: <code id="hp">…</code></span>
```

## Run it

```bash
pnpm dev
```

Open the page. You spawn in `(0, 0)` of a fresh dungeon. Two
or three red `r` glyphs appear scattered on floor tiles —
that's your rat population. They start out idle (still in
chapter 09 behavior, no tick yet) until you make your first
move. Click a floor tile.

As your `@` walks toward the destination, the rats start
walking too. If one's within six tiles of you, it chases you
along the shortest path A\* finds. If they're far away, they
wander aimlessly.

Click on a rat's tile. Your player walks toward it; on reaching
an adjacent tile, the bump-attack logic fires — you damage the
rat (`HP: 2/3`), the rat damages you (`HP: 17/20`). Keep
attacking. The rat dies and disappears from the canvas.

Walk into a cluster of rats and let them gang up on you. HP
drops fast. Get to 0 → you respawn at the corner of the room
at full HP. The rats are now between you and your original
position; they'll come after you again.

Try a few:

- **Walk through a door at low HP.** You enter the new room at
  full HP. That's the per-room HP simplification we picked;
  treating HP as a "scratch field" that resets on entry. The
  trade-off section names the fix.
- **Stand still and let a rat bite you.** Your HP ticks down
  by 1 every 200 ms until you walk away or fight back.
- **Kill all rats in a room, leave, come back.** The room's
  `onInit` has already run (memory driver); the persisted
  state has fewer mobs. Restart the server to repopulate.

## Trade-offs worth naming

Two design choices that the chapter took the easy way out on:

- **HP resets on room entry.** The simplest model. To carry
  HP between rooms, move it onto the `Player` actor and have
  `Room.addEntity` accept an `hp` argument the Player passes
  in. The room's tick is then mutating a value that originated
  on the Player — strictly speaking a saga, but a cheap one
  because the Player isn't observing.
- **Dead mobs don't respawn.** Once a room's rats are killed,
  they're gone (within the session — memory driver loses the
  snapshot on restart). Chapter 14 introduces durable reminder-
  driven respawn ("respawn this mob in 30 seconds"); applying
  it here is a one-line change.

Both belong in a polish pass once we've covered reminders
(ch 14) and Player-state synthesis. Mentioned so you don't
think they're framework limitations.

## Commit + tag

```bash
git add .
git commit -m "ch11: mobs as room-state; AI + bump combat"
git tag ch11-done
```

## Recap

| New concept                          | Where it landed                         |
| ------------------------------------ | --------------------------------------- |
| Mobs as state inside the room actor  | `Entity.type = 'mob'`; no `Mob` class   |
| Single-mailbox-turn AI + combat      | All seven phases inside one `tick`      |
| Mob spawn deterministic per actor id | `generateMobs(seed, tiles)` in `onInit` |
| Bump-attack in both directions       | `isEnemy(a, b)` + phase 2 of the tick   |
| Deferred damage apply                | Phase 2 collects, phase 3 applies       |
| Player respawn on death              | Phase 5 of the tick                     |

What didn't change:

- The Room, Player, Merchant, and Dungeon actor _classes_ —
  same shape as ch 10. We only added handlers and grew the
  entity record.
- The chapter 06 WS protocol, chapter 08 transition saga,
  chapter 09 dungeon graph, chapter 10 merchant flow — all
  intact.
- The renderer's two-pass layered draw (tiles → entities).
- The interlude's checklist — mobs validate it.

The lesson worth carrying forward: **when the interlude's
checklist says "no" to all three questions, trust it.** Don't
write a `Mob` actor because mobs feel like actors. Write a
field on the room and let the tick handler do its job.

## What's next

**Chapter 12 — Auth + `policy()`** finally gates the action.
Today any caller can `move` any player's character — the room
handlers trust the `playerId` arg. In chapter 12 we plug in
the BYO auth hook from Phase 5.3 and write `static policy(p,
action)` statics on each actor class so a Principal can only
control their own entities.

After that, **chapter 13** introduces capability tokens for
"share-a-dungeon" read-only links, and **chapter 14** wires
the durable reminder for monster respawn.

---

## Troubleshooting

**Rats stand frozen when you enter a room**

The tick isn't ticking. The most likely cause: `addEntity`
isn't calling `ensureTickRunning`. The check is "are there any
mobs in the room?" — if true, kick off the tick. Make sure
that line is awaited.

**Player can walk through rats**

The bump-attack logic only fires when an entity tries to step
_onto_ an enemy's exact tile. If the player's path's next step
isn't the rat's tile (e.g., they're walking diagonally past
it), no bump. That's by design: bump-attack is for head-on
collisions, not adjacency. To make it adjacency-based you'd
change phase 2 to attack any enemy within distance 1 instead
of strictly at the destination tile.

**Two rats both kill the player on the same tick**

That's correct — the deferred damage apply means both rats
register their hits against the pre-tick HP. The player ends
up with two damage entries against them, hp drops to 0, they
respawn. If you'd rather "first hit wins, second is wasted,"
move the damage apply into phase 2 and check `victim.hp` in
each iteration.

**Rats path through walls**

They shouldn't — `findPath` uses `isPassable` which only
allows `.` and `+` tiles. If you see this, your `tiles` array
has stale data, or you've extended `isPassable` somewhere.
Check `pathfinding.ts`'s exports.

**Server CPU pegged at 100%**

Every populated room is ticking. With a 3×3 dungeon and a
player in one room, only that room ticks — the others sit
idle (no players, no tick). If you're seeing CPU saturation,
either the reschedule guard is too permissive (does it stop
when both `hasPlayer` and `hasMob` are false?) or you have
hundreds of rooms with players in them, which is a different
class of problem.

**Subscription patches are huge after walking into a room
full of rats**

The first-time entry runs `onInit`, which materializes the
room with the full mob population. The snapshot frame includes
every mob, every tile, every entity. That's expected on
first subscribe; subsequent patches are tiny diffs (mob
position deltas, HP changes). The chapter 06 wire-cost
breakdown still applies.

**`Math.random` makes mob behavior non-deterministic between
restarts**

That's intentional for tutorial-grade behavior. To make it
deterministic, store a `prng` field on `RoomState` (a seed
number), and use `mulberry32(state.prng)` inside `tick`,
updating `state.prng` after each consumption. Chapter 14's
event-sourced replay relies on this kind of determinism;
ch 11 doesn't need it.
