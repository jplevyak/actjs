# Chapter 08 — Room transitions

> **Chapter goal:** walking onto a door tile transfers the player
> into a fresh neighboring room. The transition is a three-step
> saga across two actors (Room + Player), with each step
> idempotent so retries are safe. The browser observes the
> transition by subscribing to the Player actor and swapping
> its Room subscription when `currentRoomId` changes.
>
> **Time budget:** ~75 minutes.
>
> **End-of-chapter tag:** `ch08-done`.

---

Chapter 07 gave each player their own actor with a `currentRoomId`
field. That field has been a placeholder so far — set on join,
never touched again. This chapter makes it move. The door tile
the procgen has been painting since chapter 03 finally goes
somewhere.

The actjs lesson is a hard one: **there are no atomic
transactions across actors.** Each actor's mailbox is its own
consistency boundary. When a single user action needs to mutate
two actors — leave room A, enter room B — you can't wrap them in
a `BEGIN ... COMMIT`. What you _can_ do is design a sequence of
idempotent steps that can be retried at any point and end up in
the right state. That's the **saga** pattern, and chapter 08 is
where it earns its keep.

By the end of this chapter you will:

- Have a three-step saga in the `Player` actor that removes the
  entity from the old room, updates `currentRoomId`, and joins
  the new room.
- Understand why each step is idempotent and what a partial
  failure looks like in each.
- Have a `removeEntity` handler on `Room` that mirrors
  `addEntity` from chapter 07 (idempotent, single source of
  truth for "who's in this room").
- Have a `tick` handler that detects when an entity steps onto
  a door tile and initiates the transition via cross-actor
  `tell`.
- Have a browser that subscribes to **both** the room and the
  player, swapping its room subscription when `Player.currentRoomId`
  changes.

## Why no atomic transactions across actors?

Two actors, two mailboxes, two snapshot rows. Mutating both
"atomically" would mean coordinating a two-phase commit between
them — which actjs deliberately doesn't ship, because actor-model
correctness is a different shape than transactional correctness.

If you wrote this in Postgres, the natural answer would be:

```sql
BEGIN;
UPDATE room SET entities = ... WHERE id = $OLD;
UPDATE player SET current_room_id = $NEW WHERE id = $PLAYER;
UPDATE room SET entities = ... WHERE id = $NEW;
COMMIT;
```

In actjs that's three separate mailbox turns on three separate
actors. Any one of them can fail (the actor is over its mailbox
cap, the network blipped, the process crashed) and you have to
think about what happens next.

The saga answer is: don't try to be atomic; be **resumable**.
Make every step idempotent, and have a retry policy that walks
the saga from wherever it stopped to wherever it should land.

## The saga

```
Player.transitionThroughDoor({fromRoomId})
  ├─ step 1: oldRoom.removeEntity({playerId})   (idempotent)
  ├─ step 2: this.state.currentRoomId = newRoomId  (idempotent)
  └─ step 3: newRoom.addEntity({playerId, displayName})  (idempotent)
```

Each step's idempotence:

- **`removeEntity`** — filters the entity out of the list. If
  it's already gone, the filter is a no-op.
- **Assigning `currentRoomId`** — setting `state.currentRoomId
= 'X'` twice is no different from setting it once. (Setting it
  to a _different_ value would be a problem, but the retry uses
  the same `newRoomId`.)
- **`addEntity`** — already idempotent from chapter 07: if the
  player is already in the room, it returns their current
  position without re-spawning them.

This means the saga can be safely retried from the beginning at
any point. If it stops between step 1 and step 2, the next attempt
re-runs step 1 (no-op), runs step 2 (commits the new room id),
runs step 3 (spawns the entity). If it stops between step 2 and
step 3, the next attempt runs all three again with the same
effect — step 1 is a no-op (we already left the old room), step 2
re-sets to the same value, step 3 spawns.

**Where does retry come from in the tutorial?** Two places.
The browser can retry the original HTTP call (with the same
`Idempotency-Key` for free; ch 5.1 covers that). And the
runtime itself, when chapter 16 graduates to the PG-backed
driver, can replay an undelivered tell after a crash. For the
memory-driver tutorial we won't hit either case in practice,
but the design is ready for both.

## Picking the destination room

Chapter 08 doesn't yet have a dungeon graph (that arrives in
chapter 09). When the player steps on a door, we have to pick
_something_ as the new room. The simplest answer: **mint a
fresh `Room` actor**. Every door leads to a brand-new
procedurally-generated dungeon.

This is decided server-side, in the Player's
`transitionThroughDoor` handler. The reader doesn't have to
think about it. Chapter 09 swaps the `randomUUID()` line for
`dungeon.call.neighborOf({fromRoomId, doorPosition})` and the
saga shape stays the same.

## Add `removeEntity` to the Room

Open `src/room.ts` and add a handler that mirrors `addEntity`:

```ts
/**
 * Remove a player entity from this room. Idempotent — calling
 * this for a player that isn't in the room is a no-op. Used by
 * the chapter-08 transition saga.
 */
@handler('removeEntity')
removeEntity(args: { playerId: string }): { ok: true } {
  this.state.entities = this.state.entities.filter(
    (e) => e.id !== args.playerId,
  );
  return { ok: true };
}
```

Two notes:

- **The filter pattern beats `splice`**. Filtering allocates a new
  array; splice mutates in place. With actjs's framework-side
  patch generation (RFC 6902 against the prior state), filtering
  produces a clean "remove this element" patch op; splice can
  produce a confusing "replace tail" patch. Filtering is the
  safer default.
- **`ok: true` is the convention** for void-shaped handler
  returns. We could return `void` and the runtime would send
  back `undefined`, but `{ok: true}` is cheap and gives clients
  something to log.

## Detect the door step in `tick`

Now teach the tick handler to notice when an entity stops on a
door tile. Replace the existing `tick` body:

```ts
import { asClassName, asActorId, asVersion } from '@jplevyak/actjs/types';
import type { ActorRef } from '@jplevyak/actjs/types';

// ... existing imports ...

@handler('tick')
async tick(): Promise<void> {
  this.state.tickScheduled = false;
  // Collect transitions during the iteration; act on them after,
  // so we don't mutate `entities[]` while iterating.
  const transitions: { entity: Entity; fromRoomId: string }[] = [];

  for (const e of this.state.entities) {
    const next = e.path.shift();
    if (next) {
      e.x = next.x;
      e.y = next.y;
    }
    // Did this entity step onto a door tile?
    const tile = this.state.tiles[e.y]?.[e.x];
    if (tile === '+') {
      transitions.push({ entity: e, fromRoomId: this.actor_id as string });
    }
  }

  // Run transitions. Each one removes the entity from this room
  // (local mutation) and tells the Player to complete the saga.
  for (const t of transitions) {
    this.state.entities = this.state.entities.filter((e) => e.id !== t.entity.id);
    const player: ActorRef = {
      class: asClassName('Player'),
      id: asActorId(t.entity.id),
      version: asVersion('1.0.0'),
    };
    await this.actjs!.tell(player, 'transitionThroughDoor', {
      fromRoomId: t.fromRoomId,
    });
  }

  // Reschedule if anyone is still moving.
  const anyMoving = this.state.entities.some((e) => e.path.length > 0);
  if (anyMoving) await this.ensureTickRunning();
}
```

Three things worth pausing on:

- **`tell`, not `call`.** The room doesn't need the Player's
  response, and using `call` would block the tick on the
  Player's mailbox. Using `tell` keeps the tick fast; the
  Player handles the rest asynchronously via the durable
  inbox. If the tell were to fail (it shouldn't — the inbox
  is durable), the entity stays gone from the old room and
  the Player needs to recover; chapter 16's audit log gives
  operators visibility.
- **Local mutation before tell.** The entity is removed from
  `state.entities` _before_ the tell goes out. By the time the
  Player's handler runs, the room has already broadcasted the
  patch removing the entity. Subscribers see the entity vanish
  from the old room first; later, the new room broadcasts the
  entity appearing.
- **Why not call?** The deadlock case: if the Room calls the
  Player and the Player calls back to the Room (to remove its
  entity), the Room's mailbox is busy with the tick handler
  and can't process the Player's removal call. Deadlock. We
  sidestep this by having the Room remove the entity itself
  before notifying the Player.

## Add the `transitionThroughDoor` handler to Player

Edit `src/player.ts`. Add an import for `randomUUID` and a new
handler:

```ts
import { randomUUID } from 'node:crypto';

// ... existing imports + class ...

/**
 * Complete a door-step transition. The originating room has
 * already removed our entity (so subscribers see the departure
 * immediately); this handler picks a destination room, updates
 * `currentRoomId`, and joins the new room.
 *
 * For chapter 08, every door leads to a brand-new room. Chapter
 * 09's `Dungeon` actor will replace `randomUUID()` with a
 * neighbor-graph lookup.
 *
 * Each step is idempotent (see `Player.join` for `addEntity`'s
 * contract); retries are safe.
 */
@handler('transitionThroughDoor')
async transitionThroughDoor(args: { fromRoomId: string }): Promise<{
  newRoomId: string;
}> {
  // Step 1 already happened: the originating Room removed our
  // entity before sending this tell. The `oldRoom.removeEntity`
  // call is here defensively — calling it on a room that no
  // longer has our entity is a no-op (chapter-08 idempotency).
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

  // Step 2: update `currentRoomId`. Browsers subscribed to this
  // Player observe the change via a patch.
  const newRoomId = randomUUID();
  this.state.currentRoomId = newRoomId;

  // Step 3: spawn into the new room. The new room is materialized
  // by this call (chapter 02's lazy-actor rule).
  const newRoom: ActorRef = {
    class: asClassName('Room'),
    id: asActorId(newRoomId),
    version: asVersion('1.0.0'),
  };
  await this.actjs!.call(newRoom, 'addEntity', {
    playerId: this.actor_id as string,
    displayName: this.state.displayName,
  });

  return { newRoomId };
}
```

Two things to note:

- **The defensive `removeEntity` call.** Chapter 08's flow has
  the room removing the entity before sending the tell, so the
  call here is "belt and suspenders." If the tell ever arrived
  without the room having removed the entity (e.g. it's a
  replay from the durable inbox after a crash), the defensive
  call cleans up. The `args.fromRoomId === currentRoomId`
  guard prevents a stale tell from undoing a subsequent
  transition.
- **`randomUUID()` server-side.** Browsers don't get to pick
  the destination — the Player handler does. That makes the
  saga deterministic per-step. Chapter 09's dungeon graph
  swap-in will replace this line; the handler shape doesn't
  change.

## Update the browser

The browser needs two changes:

1. **Subscribe to the Player** in addition to the Room.
2. **Swap the Room subscription** when `Player.currentRoomId`
   changes.

Replace `public/main.js` (the renderer + helpers stay; the
`main()` function changes):

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
  const [playerId, initialRoomId] = await Promise.all([getOrMintPlayer(), getOrMintRoom()]);
  document.getElementById('playerInfo').textContent = playerId.slice(-8);

  const canvas = document.getElementById('dungeon');
  const wsUrl = `${location.origin.replace(/^http/, 'ws')}/v1/ws`;
  const client = new WsClient(wsUrl);
  await client.connect();

  // Track our active room subscription so we can swap it when
  // the player transitions through a door.
  let roomUnsub = null;
  let activeRoomId = null;

  async function switchToRoom(newRoomId) {
    if (newRoomId === activeRoomId) return;
    if (roomUnsub) {
      await roomUnsub();
      roomUnsub = null;
    }
    activeRoomId = newRoomId;
    history.replaceState(null, '', `?id=${newRoomId}`);
    document.getElementById('roomId').textContent = newRoomId;
    roomUnsub = await client.subscribe('Room', newRoomId, (state) => render(canvas, state));
  }

  // Subscribe to the Player so we observe `currentRoomId` changes.
  // The listener fires immediately with the initial snapshot, then
  // on every patch — including the one that lands when the
  // transition saga runs.
  await client.subscribe('Player', playerId, (state) => {
    if (state.currentRoomId && state.currentRoomId !== activeRoomId) {
      void switchToRoom(state.currentRoomId);
    }
  });

  // Initial join. The Player handler will set currentRoomId, the
  // subscription above will pick it up, and switchToRoom will
  // subscribe to the room.
  await rpc(`/v1/actors/Player/${playerId}/join`, { roomId: initialRoomId });

  canvas.addEventListener('click', async (event) => {
    if (!activeRoomId) return;
    const rect = canvas.getBoundingClientRect();
    const tx = Math.floor((event.clientX - rect.left) / TILE);
    const ty = Math.floor((event.clientY - rect.top) / TILE);
    await rpc(`/v1/actors/Room/${activeRoomId}/move`, { playerId, x: tx, y: ty });
  });
}

main().catch((err) => {
  document.body.innerHTML = `<pre style="color:#f55;padding:1rem">${err.stack}</pre>`;
});
```

Four pieces worth noticing:

- **Two concurrent subscriptions.** One per actor. The
  `WsClient` from chapter 06 already multiplexes them onto a
  single WebSocket; we're not opening anything new.
- **The `switchToRoom` helper.** Tears down the old room
  subscription before starting the new one. Importantly, it's
  guarded against re-firing for the same room — the Player
  subscription's listener fires on every patch, and we don't
  want a click → tick → Player patch (no room change) cascade
  to re-subscribe.
- **`activeRoomId` controls the click handler.** Clicks before
  `activeRoomId` is set are dropped (we're still mid-join).
  Once the Player subscription has fired with a valid
  `currentRoomId`, clicks route to the right room.
- **URL stays in sync.** Each `switchToRoom` updates `?id=...`
  so reloading lands you in the current room.

## Run it

```bash
pnpm dev
```

Open the page. Click on a door tile (the orange `+` at the top
center of most rooms). The player walks to it. As soon as they
step onto it, the entity vanishes from the current room's
broadcast, the player's `currentRoomId` flips, the browser
unsubscribes from the old room and subscribes to a new one
that gets generated on the fly. The URL updates to the new
room id; if you reload now, you stay in the new room.

Try a few:

- **Walk through a door, then walk through another.** Each
  transition mints a fresh room. The room graph is currently
  a tree of orphaned dungeons; chapter 09 will replace this
  with a proper graph where transitions return to known rooms.
- **Two browser tabs in the same room, one walks through a
  door.** The remaining tab sees the entity vanish (its room
  doesn't change — it's still subscribed to the old room).
  The transitioning tab follows the player to the new room.
  Genuinely multiplayer behavior fall out of two subscriptions.
- **Open a second private window with a different player.**
  Both players in the same room. One walks through a door:
  vanishes from the other player's view. The remaining player
  is still in the original room; if _they_ walk through a
  door, they end up in a _different_ new room (different
  random `newRoomId`s). Chapter 09 fixes this — adjacent rooms
  share neighbors.

## What the subscription patches look like

Pop the Network panel and watch the WebSocket frames while
walking onto a door. You'll see four patches relevant to the
transition, in order:

1. **`Room A` patch** — the entity's path is consumed
   step-by-step (one `replace` op on `/entities/0/x`,
   `/entities/0/y`, and a `remove` on `/entities/0/path/0`
   per tick).
2. **`Room A` patch** — the entity stepped onto the door;
   `remove` on `/entities/0` (the whole entity).
3. **`Player` patch** — `replace` on `/currentRoomId` from
   the old id to the new one.
4. **`Room B` snapshot** — full state of the new room
   (because we just subscribed to it).

That's three patches and one snapshot, all multiplexed over the
one WS. No new wire concepts; the chapter-06 protocol carries
this just fine.

## Commit + tag

```bash
git add .
git commit -m "ch08: room-transition saga; doors lead to fresh rooms"
git tag ch08-done
```

## Recap

Two new actjs concepts, one important non-concept:

1. **The saga pattern.** A sequence of idempotent steps across
   actors. No atomic-across-actors guarantee, but each step
   can fail and retry independently — and as long as the
   per-step operations are idempotent, the whole thing
   converges to the correct final state regardless of where
   it stopped.
2. **Cross-actor `tell` for fan-out.** When the room initiates
   a transition, it uses `tell` (fire-and-forget) rather than
   `call` to avoid serializing on the Player's mailbox _and_
   to avoid the Room ⇄ Player deadlock from a cyclic
   `call`-chain.
3. **(The non-concept):** distributed transactions. actjs
   deliberately doesn't ship two-phase commit. Drawing
   actor boundaries is drawing transactional boundaries; the
   saga is the chosen alternative when a single user
   action's work crosses one of those boundaries.

Plus one craft move:

- **Subscribing to multiple actors per page.** The Player
  subscription is the new piece; the Room subscription
  becomes dynamically scoped (un/re-subscribed as
  `currentRoomId` changes). The pattern generalizes to any
  client that observes a player's view of the world: their
  party, their inventory, their nearby NPCs are all separate
  subscriptions on the same `WsClient`.

What didn't change: the renderer, the WS client + JSON Patch
applier, A\* pathfinding, the tick scheduling pattern, the
chapter-07 Player.join handler. All of those are reused
verbatim.

## What's next

**Chapter 09 — Procgen graph of rooms** replaces `randomUUID()`
in `Player.transitionThroughDoor` with a lookup against a new
`Dungeon` actor. The Dungeon pre-generates the room graph
(`room → neighbors[]`) and lazily mints `Room` actors as
players enter them. The saga shape stays the same; the
"where am I going?" answer becomes deterministic and
revisitable.

After that, **chapter 10** introduces the merchant — the
cross-location shared identity pattern. The saga we just wrote
becomes one of three saga-shaped flows in the tutorial; the
others (merchant trade, party loot roll) reuse the same
"steps, each idempotent" muscle memory.

---

## Troubleshooting

**Player walks through the door but the browser stays on the
old room**

The Player subscription isn't firing, or the listener isn't
calling `switchToRoom`. Open the Network panel's WS messages
and confirm you see a patch with `op: 'replace', path: '/currentRoomId'`.
If yes, the patch is arriving and your listener is the
problem — check that `switchToRoom` actually runs
(`console.log` inside it). If no, the Player's
`transitionThroughDoor` handler didn't fire; check the server
logs for a stack trace.

**Entity disappears from both rooms**

The transition completed steps 1 and 2 (remove + update
`currentRoomId`) but step 3 (`addEntity` on the new room)
failed. The room IDs are random so retry is hard. For a
debug session, log inside `transitionThroughDoor` to confirm
all three calls return; or downgrade `tell` → `call` in the
Room's tick (one chapter early to expose the cause).

**"player X is not in this room" when clicking after a transition**

The browser sent a `move` for the new room before the Room
subscription's snapshot arrived; the new room actor knows
nothing about you yet. The `activeRoomId` guard should
prevent this — if you see it firing, check that the click
handler reads `activeRoomId` at click time, not at script
load time.

**Two tabs end up in different rooms after walking through the
same door**

The transition mints a fresh room per Player. Tab 1's player
got room X; tab 2's player got room Y. That's expected for
chapter 08 — every door leads somewhere new, _per player_.
Chapter 09 will make doors lead to the same room on both
sides (shared neighbors).

**Player snapshot keeps rendering an old `currentRoomId`**

You probably re-subscribed before unsubscribing — the
`SubscriptionState` in the SDK / hand-roll caches per
subscription id. The `switchToRoom` helper awaits the
unsubscribe before starting the new one; if you parallelized
them, the order of patches gets confusing.

**`Cannot read properties of undefined (reading 'tell')`**

`this.actjs` is undefined — you're calling the handler
outside a runtime (e.g. directly in a unit test).
`TestRuntime` from `@jplevyak/actjs/test` (see
`docs/testing.md`) wires it for you; raw `new Room()` does
not.
