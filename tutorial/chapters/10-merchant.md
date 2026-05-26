# Chapter 10 — Merchants: cross-location shared identity

> **Chapter goal:** introduce a `Merchant` actor whose identity
> outlives any room. Garrick has one inventory; he appears in
> rooms `(0, 0)` and `(2, 2)` of the dungeon; buying his last
> potion in one room makes it unavailable in the other. The
> mailbox is the lock — no application-level coordination
> required.
>
> **Time budget:** ~75 minutes.
>
> **End-of-chapter tag:** `ch10-done`.

---

This is the first chapter where the actor model starts paying
real dividends. So far every actor has had a clear spatial or
ownership relationship: rooms own tiles, players own
themselves. Merchants break that mold. Garrick is _one_ actor;
he can be _present_ in many rooms at the same time; his
inventory is single-source-of-truth across every appearance.

This is the **cross-location shared identity** pattern from the
interlude. It's the exact opposite shape of "mobs in a room"
(which we'll see in chapter 11). Mobs are state inside a parent
actor — they only exist in their room's context, and they
multiply naturally when you have many rooms. Merchants are
their own actor — they have identity that transcends rooms, and
they're the only place their inventory exists.

The contended-resource demo is the test of correctness: two
players in two different rooms each click "Buy potion" at the
exact same moment, with one potion left in stock. Exactly one
wins. We don't write any locking code to make this true.

By the end of this chapter you will:

- Have a `Merchant` actor with `appearIn`, `leave`, and
  `purchase` handlers.
- Have an `Entity.type` field discriminating players from
  merchant presences in a room.
- Have a `Player.addItem` handler that records purchased items
  in the inventory slot that's been waiting since chapter 07.
- Have wired `Dungeon.enter` to place Garrick in two rooms
  (idempotently — repeat calls are safe).
- Have a browser that renders merchants with a distinct glyph
  and shows a "Buy potion" button when one's in your room.
- Have demonstrated the race: two browsers, one potion, exactly
  one wins.

## Why a separate Merchant actor

The interlude listed three trade-off questions for "should this
be its own actor?" Let's run them against Garrick:

- **Serial writes for correctness?** Yes. Multiple players
  buying from Garrick concurrently is the headline problem;
  the mailbox is the lock.
- **Lifetime independent of any single room?** Yes. Garrick
  doesn't disappear when room `(0, 0)` is evicted; he doesn't
  duplicate when he "appears" in `(2, 2)`. His state is
  per-merchant, not per-room.
- **Other actors need to subscribe to him?** Yes (eventually).
  In this chapter, players subscribe via `Player.whoami` to
  see new items in their inventory; future chapters could
  have UI elements subscribe to the merchant directly to see
  inventory shrink in real time.

Three yeses → its own actor. The Room actors hold a _presence
record_ (just position + display name) so the renderer can
draw Garrick. They never duplicate his inventory.

## The buy saga

The flow we're building:

```
Browser    →  POST /v1/actors/Merchant/Garrick/purchase
              { playerId, item: 'potion' }

Merchant   →  1. Check this.state.inventory.potion > 0
              2. Decrement: this.state.inventory.potion -= 1
              3. Call Player.addItem({ item: 'potion' })
              4. Return { ok: true, item: 'potion' }

Browser    ←  { ok: true, item: 'potion' }
```

Failure modes:

- **Out of stock.** Step 1 fails. The handler returns
  `{ ok: false, reason: 'out-of-stock' }` without touching
  state. Idempotent — calling again returns the same answer.
- **Player handler fails after decrement.** If
  `Player.addItem` throws, we've decremented the merchant's
  inventory but the player didn't get the item — money for
  nothing. The handler catches and **compensates** by
  re-incrementing the inventory before re-throwing. The
  state is restored to pre-decrement.

The compensating write is the chapter's most important code
read. In a Postgres world you'd wrap the four steps in a
transaction and `ROLLBACK` on failure. In actjs you can't —
there's no transaction across actors. The saga + compensation
is the chosen alternative.

## Define the Merchant actor

Create `src/merchant.ts`:

```ts
import { Actor } from '@jplevyak/actjs/actor';
import { handler } from '@jplevyak/actjs/handler';
import type { ActorRef } from '@jplevyak/actjs/types';
import { asActorId, asClassName, asVersion } from '@jplevyak/actjs/types';

export interface MerchantLocation {
  roomId: string;
  x: number;
  y: number;
}

export interface MerchantState {
  displayName: string;
  /** Item id → stock count. */
  inventory: Record<string, number>;
  /** Rooms where the merchant is currently visible. */
  locations: MerchantLocation[];
}

export type PurchaseResult =
  | { ok: true; item: string }
  | { ok: false; reason: 'out-of-stock' | 'unknown-item' };

export class Merchant extends Actor<MerchantState> {
  override onInit(): void {
    // Garrick's opening inventory. One potion specifically — so
    // we can race two players for it in the deliverable.
    this.state = {
      displayName: `Garrick the Trader`,
      inventory: { potion: 1, sword: 1 },
      locations: [],
    };
  }

  @handler('read')
  read(): MerchantState {
    return this.state;
  }

  /**
   * Make the merchant visible in the named room at (x, y).
   * Idempotent: calling for a room the merchant is already in
   * is a no-op. Called by the Dungeon on first player entry.
   */
  @handler('appearIn')
  async appearIn(args: { roomId: string; x: number; y: number }): Promise<{ ok: true }> {
    const existing = this.state.locations.find((l) => l.roomId === args.roomId);
    if (existing) return { ok: true };
    this.state.locations.push({ roomId: args.roomId, x: args.x, y: args.y });

    const room: ActorRef = {
      class: asClassName('Room'),
      id: asActorId(args.roomId),
      version: asVersion('1.0.0'),
    };
    await this.actjs!.call(room, 'addMerchantPresence', {
      merchantId: this.actor_id as string,
      displayName: this.state.displayName,
      x: args.x,
      y: args.y,
    });
    return { ok: true };
  }

  /**
   * Remove the merchant from the named room. Idempotent.
   */
  @handler('leave')
  async leave(args: { roomId: string }): Promise<{ ok: true }> {
    const before = this.state.locations.length;
    this.state.locations = this.state.locations.filter((l) => l.roomId !== args.roomId);
    if (this.state.locations.length === before) return { ok: true }; // wasn't there

    const room: ActorRef = {
      class: asClassName('Room'),
      id: asActorId(args.roomId),
      version: asVersion('1.0.0'),
    };
    await this.actjs!.call(room, 'removeEntity', {
      playerId: this.actor_id as string,
    });
    return { ok: true };
  }

  /**
   * The headline handler. Verify stock, decrement, hand the
   * item to the buyer. If `Player.addItem` fails, compensate by
   * refunding the inventory before re-throwing.
   *
   * Two players racing for the last potion: the mailbox
   * serializes their two calls. The first call sees stock = 1,
   * decrements to 0, hands over the potion. The second call
   * sees stock = 0 and returns `out-of-stock`. Exactly one wins
   * by construction; no application-level lock involved.
   */
  @handler('purchase')
  async purchase(args: { playerId: string; item: string }): Promise<PurchaseResult> {
    const stock = this.state.inventory[args.item];
    if (stock === undefined) return { ok: false, reason: 'unknown-item' };
    if (stock <= 0) return { ok: false, reason: 'out-of-stock' };

    // Reservation: decrement before handing off. If anything
    // downstream fails, compensate.
    this.state.inventory[args.item] = stock - 1;

    try {
      const player: ActorRef = {
        class: asClassName('Player'),
        id: asActorId(args.playerId),
        version: asVersion('1.0.0'),
      };
      await this.actjs!.call(player, 'addItem', { item: args.item });
      return { ok: true, item: args.item };
    } catch (err) {
      // Compensate: put the item back in stock and re-throw so
      // the caller knows the purchase didn't complete.
      this.state.inventory[args.item] = (this.state.inventory[args.item] ?? 0) + 1;
      throw err;
    }
  }
}
```

Five things to call out:

- **`Garrick the Trader` is a singleton.** The actor id is
  `Garrick` (the Dungeon will call `Merchant.Garrick.appearIn`
  with a fixed id). Garrick is the same Merchant actor across
  every dungeon on this server. If you've ever played an MMO
  where a named NPC is "the same person" everywhere, that's
  this pattern.
- **Inventory shape is `Record<string, number>`.** Plain key→
  count map. Real merchants would model items with price,
  variant, etc.; the tutorial keeps it minimal.
- **`appearIn` is idempotent.** Repeat calls for the same
  `roomId` are no-ops. This is what lets the Dungeon call
  `appearIn` on every player entry without worrying about
  re-spawning.
- **Compensation in the `catch` block.** This is the load-
  bearing code of the chapter. We re-increment inventory if
  the player-side step fails. Without this, a transient
  failure would silently delete inventory.
- **The mailbox guarantees serial purchases.** No locks, no
  retries, no compare-and-swap. The framework gives us this
  for free.

### Why not throw on out-of-stock?

A purist actjs design would throw `OutOfStockError` from
`purchase`, and the framework would map it to a structured
`409 OutOfStock` via `src/server/errors.ts`. Chapter 12 will do
exactly this for a related case. Chapter 10 returns a
discriminated union (`{ ok: true } | { ok: false }`) because
it's simpler to read and the failure isn't really "exceptional"
— racing for the last item is normal gameplay, not an error.

## Update the Room

The Room actor now hosts two kinds of entities: players (with
paths) and merchant presences (without). Add a `type` field
and a separate handler for merchants. Edit `src/room.ts`:

```ts
export interface Entity {
  id: string;
  type: 'player' | 'merchant';
  displayName: string;
  x: number;
  y: number;
  path: Point[]; // always empty for merchants in v1
}

export class Room extends Actor<RoomState> {
  // ... existing onInit, read, removeEntity, move, tick ...

  @handler('addEntity')
  addEntity(args: { playerId: string; displayName: string }): { x: number; y: number } {
    const existing = this.state.entities.find((e) => e.id === args.playerId);
    if (existing) return { x: existing.x, y: existing.y };
    this.state.entities.push({
      id: args.playerId,
      type: 'player',
      displayName: args.displayName,
      x: this.state.spawn.x,
      y: this.state.spawn.y,
      path: [],
    });
    return { x: this.state.spawn.x, y: this.state.spawn.y };
  }

  /**
   * Add a merchant presence to this room. Idempotent — calling
   * for a merchant already present is a no-op. Position is
   * caller-specified (the merchant picks where it stands), not
   * the spawn point.
   */
  @handler('addMerchantPresence')
  addMerchantPresence(args: { merchantId: string; displayName: string; x: number; y: number }): {
    ok: true;
  } {
    const existing = this.state.entities.find((e) => e.id === args.merchantId);
    if (existing) return { ok: true };
    this.state.entities.push({
      id: args.merchantId,
      type: 'merchant',
      displayName: args.displayName,
      x: args.x,
      y: args.y,
      path: [],
    });
    return { ok: true };
  }
}
```

Two specifics:

- **`removeEntity` doesn't need to change.** It filters by
  `id`, which is unique across both players and merchants.
  Calling `removeEntity({ playerId: 'Garrick' })` removes
  Garrick's presence; calling it with a player id removes a
  player. The argument name `playerId` is now historical — a
  rename to `entityId` is a follow-up.
- **`tick` doesn't need to change either.** It iterates
  entities and only advances `path[0]`; merchants' paths are
  always empty, so the merchant entities are unchanged on
  every tick. The door-step transition logic only fires when
  an entity's `(x, y)` lands on a `+` tile, which a stationary
  merchant won't trigger.

## Update the Player

Add a single handler to `src/player.ts`:

```ts
/**
 * Append an item to the player's inventory. Used by the
 * merchant's purchase saga (step 3 — see `Merchant.purchase`).
 * Idempotent _per call_; consecutive calls duplicate the item
 * (the merchant deduplicates by separating reservation from
 * hand-off; see the purchase compensation logic).
 */
@handler('addItem')
addItem(args: { item: string }): { ok: true; size: number } {
  this.state.inventory.push(args.item);
  return { ok: true, size: this.state.inventory.length };
}
```

That's the entire chapter-07 inventory slot finally earning its
keep.

## Wire the Dungeon to place Garrick

The Merchant exists; the Room can host his presence; he doesn't
appear in the dungeon until someone calls `Merchant.appearIn`.
We do that from `Dungeon.enter` so the first player to enter the
dungeon also places Garrick. Edit `src/dungeon.ts`:

```ts
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

  // Place Garrick in two rooms. Idempotent — `appearIn` is
  // a no-op if the merchant is already present.
  await this.placeMerchants();

  return { roomId };
}

private async placeMerchants(): Promise<void> {
  const merchant: ActorRef = {
    class: asClassName('Merchant'),
    id: asActorId('Garrick'),
    version: asVersion('1.0.0'),
  };
  // Two appearances per dungeon. The Merchant's own state
  // dedupes; calling appearIn on a room already in `locations`
  // is a no-op (idempotent).
  await this.actjs!.call(merchant, 'appearIn', {
    roomId: roomIdFor(this.actor_id as string, 0, 0),
    x: 5,
    y: 5,
  });
  await this.actjs!.call(merchant, 'appearIn', {
    roomId: roomIdFor(this.actor_id as string, 2, 2),
    x: 15,
    y: 15,
  });
}
```

The `appearIn` calls happen sequentially because the Merchant's
mailbox serializes them anyway. We could parallelize with
`Promise.all` and it would still serialize at the mailbox;
sequential is clearer.

Note that **the Merchant is shared across dungeons** because
its actor id is the fixed string `'Garrick'`. If you mint two
dungeons, both will call `Merchant.Garrick.appearIn` for their
own rooms — and Garrick will accumulate locations across both
dungeons. His one inventory is shared too. This is the cross-
location identity pattern at its most literal; we'll note the
trade-off below.

## Register the Merchant class

Open `src/server.ts` and add the `runtime.register` for
`Merchant`:

```ts
import { Merchant } from './merchant.js';

// ... existing registrations ...

runtime.register({
  name: asClassName('Merchant'),
  version: asVersion('1.0.0'),
  ctor: Merchant,
});
```

## Update the browser

Three changes in `public/main.js`:

1. **Render merchant entities with a distinct glyph.** A gold
   `M` over the regular tile.
2. **Show a "Buy potion from Garrick" button** when at least
   one merchant entity is in the current room.
3. **Subscribe to inventory.** The Player subscription already
   fires on `currentRoomId` changes (chapter 08); extend the
   listener to also render the inventory in the header.

The relevant pieces:

```js
const MERCHANT_COLOR = '#ffd700';
const MERCHANT_GLYPH = 'M';

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
    if (e.type === 'merchant') {
      ctx.fillStyle = MERCHANT_COLOR;
      ctx.fillText(MERCHANT_GLYPH, e.x * TILE + TILE / 2, e.y * TILE + TILE / 2);
    } else {
      ctx.fillStyle = colorForPlayer(e.id);
      ctx.fillText('@', e.x * TILE + TILE / 2, e.y * TILE + TILE / 2);
    }
  }
}

async function buyFrom(merchantId, playerId) {
  const res = await rpc(`/v1/actors/Merchant/${merchantId}/purchase`, {
    playerId,
    item: 'potion',
  });
  const status = document.getElementById('status');
  if (res.result.ok) {
    status.textContent = `Bought ${res.result.item} from ${merchantId}.`;
    status.style.color = '#6f6';
  } else {
    status.textContent = `Couldn't buy: ${res.result.reason}.`;
    status.style.color = '#f66';
  }
}
```

In `main()`, after the player subscription is set up, also keep
the latest room state around so the buy button knows whether
a merchant is present, and add the button itself:

```js
let latestRoomState = null;

async function switchToRoom(newRoomId) {
  if (newRoomId === activeRoomId) return;
  if (roomUnsub) {
    await roomUnsub();
    roomUnsub = null;
  }
  activeRoomId = newRoomId;
  document.getElementById('roomId').textContent = newRoomId;
  roomUnsub = await client.subscribe('Room', newRoomId, (state) => {
    latestRoomState = state;
    render(canvas, state);
    updateBuyButton();
  });
}

function updateBuyButton() {
  const btn = document.getElementById('buyButton');
  const merchant = latestRoomState?.entities.find((e) => e.type === 'merchant');
  if (merchant) {
    btn.style.display = 'inline-block';
    btn.textContent = `Buy potion from ${merchant.displayName}`;
    btn.dataset.merchantId = merchant.id;
  } else {
    btn.style.display = 'none';
  }
}

document.getElementById('buyButton').addEventListener('click', async () => {
  const merchantId = document.getElementById('buyButton').dataset.merchantId;
  if (merchantId) await buyFrom(merchantId, playerId);
});

// Extend the Player subscription to also show inventory.
await client.subscribe('Player', playerId, (state) => {
  if (state.currentRoomId && state.currentRoomId !== activeRoomId) {
    void switchToRoom(state.currentRoomId);
  }
  const inv = document.getElementById('inventory');
  inv.textContent = state.inventory.length === 0 ? 'empty' : state.inventory.join(', ');
});
```

And add the button + status line to `public/index.html`:

```html
<div class="meta">
  <span>Player: <code id="playerInfo">…</code></span>
  <span>Dungeon: <code id="dungeonInfo">…</code></span>
  <span>Room: <code id="roomId">…</code></span>
  <a href="?">fresh dungeon</a>
</div>
<div class="meta">
  <span>Inventory: <code id="inventory">empty</code></span>
  <button id="buyButton" style="display: none">Buy</button>
  <span id="status"></span>
</div>
<canvas id="dungeon"></canvas>
<script type="module" src="/main.js"></script>
```

## Run it

```bash
pnpm dev
```

Open the page. You spawn in `(0, 0)`. A gold `M` sits at tile
`(5, 5)`. The "Buy potion from Garrick the Trader" button
appears in the header strip. Click it — the status line shows
`Bought potion from Garrick.` and the inventory updates to
`potion`.

Click again. The status line shows `Couldn't buy: out-of-stock.`
Garrick's only had one potion all along.

Walk east through the door into `(1, 0)`. No merchant here; no
buy button. Walk south to `(1, 1)`, then east to `(2, 1)`, then
south to `(2, 2)`. Another gold `M` — same Garrick, different
room. The button reappears. Click it. `out-of-stock` again,
because you already bought the only potion.

### The race

Now the deliverable. Restart the server (`Ctrl-C` then `pnpm dev`
— the memory driver loses state, so Garrick has a fresh potion).

Open two browser windows in **two different private tabs** (so
they have distinct `playerId` values from `localStorage`). Both
point at the same dungeon URL (`?dungeon=...`). One player walks
to `(0, 0)` (default spawn); the other walks all the way to
`(2, 2)`.

Both click the "Buy potion" button as close to simultaneously
as possible.

**One sees success. The other sees `out-of-stock`.** Every
time, regardless of which order the clicks landed in the
network. The Merchant's mailbox serializes the two `purchase`
calls; whichever arrives first wins.

You did not write a database transaction. You did not write a
lock. The framework gives you the correctness by construction.

## What the wire looks like

Pop the Network panel. The buy click fires:

```
→ POST /v1/actors/Merchant/Garrick/purchase
    { playerId: '019e...', item: 'potion' }

← 200 OK
    { class: 'Merchant', id: 'Garrick', method: 'purchase',
      result: { ok: true, item: 'potion' } }
```

Meanwhile, the Player subscription's WS receives a patch:

```
{ op: 'add', path: '/inventory/0', value: 'potion' }
```

And the Merchant — if you happened to be subscribed to him too
— would receive a patch like:

```
{ op: 'replace', path: '/inventory/potion', value: 0 }
```

So buying triggers two patches over two subscriptions, plus one
HTTP round-trip. No special wire shape; no "merchant transaction"
protocol. Just the same JSON-RPC subscriptions and POST routes
from chapter 06.

## Commit + tag

```bash
git add .
git commit -m "ch10: Merchant actor; cross-location shared identity"
git tag ch10-done
```

## Recap

| Concept                             | Where it landed                                |
| ----------------------------------- | ---------------------------------------------- |
| Cross-location shared identity      | `Merchant` actor + `locations` array           |
| Presence-as-projection              | `Entity.type = 'merchant'` in `Room.state`     |
| Mailbox serializes contended writes | `Merchant.purchase` (no app-level locking)     |
| Saga with compensation              | `purchase`'s try/catch around `Player.addItem` |
| Singleton actor across dungeons     | `actor id = 'Garrick'` (not a UUID)            |

What didn't change:

- The room's tick + pathfinding + door logic.
- The Dungeon's neighbor graph from chapter 09.
- The chapter-08 transition saga.
- The chapter-06 WebSocket + JSON Patch wire.

Everything in this chapter is a new actor + a few handler-level
extensions. The framework didn't need to grow; the data model
did.

### A trade-off worth naming

**Garrick is shared across every dungeon on this server.**
That's a feature ("the same merchant runs his shop in every
instance") or a bug ("two unrelated parties shouldn't fight for
the same potion") depending on the gameplay you want.

The fix is mechanical: scope the merchant id to the dungeon.
Use `Merchant.${dungeonId}:Garrick` instead of `Merchant.Garrick`.
The Dungeon's `placeMerchants` constructs the id from
`this.actor_id`. Each dungeon gets its own Garrick; the
cross-location pattern still holds within a dungeon.

For chapter 10's lesson — that a single actor can serve as the
consistency boundary across multiple physical locations — the
singleton scope is sharper. Real games would pick per their
design.

## What's next

**Chapter 11 — Mobs as room-state** flips the design question.
Where merchants are separate actors (because identity transcends
location), monsters are state inside the room (because they
only exist in their room's context). The interlude predicted
this; chapter 11 makes it concrete with a wandering rat that
chases the nearest player. The room's tick handler gets
busier; no new actor class.

---

## Troubleshooting

**Merchant doesn't appear in `(2, 2)` even after walking there**

The merchant is placed via `Dungeon.enter`, which fires once
per `join`. If you minted the dungeon before chapter 10's code
was deployed, `placeMerchants` hasn't run. Click "fresh
dungeon" to mint a new one.

**`out-of-stock` on the very first buy**

You probably hit the server with a previous request in the
same session. Restart the server (`Ctrl-C`, `pnpm dev`) — the
memory driver loses state, so Garrick's inventory resets to
the `onInit` defaults.

**Two browsers in two different rooms both succeed**

You're testing across two different dungeons. Each dungeon
places its own `appearIn` on the singleton Garrick, but the
inventory is shared — so racing across dungeons should still
yield exactly one winner. If you're seeing two winners,
check that both browsers' `?dungeon=...` matches.

**Buy button stays visible after walking away from the
merchant**

The `updateBuyButton` helper runs on every Room subscription
fire. If the patch removed the merchant entity (chapter 11
will exercise this with monster deaths; doesn't happen in ch
10), the button should hide. If you see the bug, check that
`latestRoomState.entities` is being updated by the
subscription listener.

**Inventory shows duplicate `potion` entries after restart**

Chapter 10 uses `state.inventory.push` without dedupe. Each
successful purchase adds one entry. If you bought a potion,
restarted (which loses Garrick's inventory but _not_ your
local-browser-memory of past purchases — wait, that's also
lost; memory driver), and bought again, you'd see two
entries _across two server boots_. Within one server boot,
one purchase per player is the limit.
