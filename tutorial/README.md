# Tutorial — Multiplayer dungeon crawler with actjs

> **This file is the outline / plan, not the tutorial itself.** It
> exists to keep the chapter order, learning goals, and deliverables
> visible before any tutorial prose is written. Chapter files
> (`01-...`, `02-...`) land here as each one is drafted.

## Pitch

A top-down, tile-based, click-to-move multiplayer dungeon crawler.
The world is split into rooms; each room is one actjs actor that
owns its tiles, items, and the entities currently inside it. Players
click where they want to go, the server runs A\* on the room's
grid, and a fixed-tick simulation advances every moving entity one
tile at a time, broadcasting RFC 6902 patches to subscribed clients.

The point is to teach actjs by building something visibly fun. Every
feature added to the game corresponds to one or two framework
primitives:

| Feature                             | Framework primitive / pattern              |
| ----------------------------------- | ------------------------------------------ |
| Room with persistent state          | `Actor<S>` + snapshots                     |
| Move / pick up item                 | `@handler` methods                         |
| Real-time animation tick            | `actjs.scheduleAt` reminder loop           |
| Multiplayer visibility              | WebSocket subscriptions + patches          |
| Procgen dungeon                     | `onInit` + deterministic seed              |
| Reconnection                        | `actor.subscribe` snapshot replay          |
| Turn timeouts / cooldowns           | reminders                                  |
| Player ↔ room transitions           | cross-actor calls + sagas                  |
| Merchant in multiple rooms          | **Cross-location shared identity** pattern |
| Party / group play + shared loot    | **N-way collaborative write** pattern      |
| "Can't move on someone else's turn" | `static policy()`                          |
| Share-a-dungeon link                | capability tokens                          |
| Replay / audit                      | event-sourced actor variant                |
| Production scrutiny                 | rate limits + active-actor caps            |

The pattern names in the right column are picked up again in the
**Choosing actor granularity** interlude between Parts III and IV
and in the **Pattern catalog** at the bottom. The point is to leave
readers with a framework for designing their _own_ actors, not just
a copy-paste recipe.

## Game design (just enough to anchor the code)

- **Genre.** Top-down 2D tile-based dungeon crawler.
  - Sprites optional; ASCII tile renderer is the default so readers
    focused on the backend don't have to source art.
- **Map.** A dungeon is a graph of **rooms**. Each room is a 20×20
  tile grid. Adjacent rooms connect via doors at fixed edge tiles.
- **Movement.** Click-to-move. Server runs A\* on the destination
  tile's room grid, emits the chosen path as an event, then advances
  one tile per **tick** (200 ms). Clients animate the in-between
  frames locally.
- **Combat.** Bump-to-attack. Walking into a hostile mob's tile
  triggers an attack on the next tick; HP / damage live in the
  attacker / defender's entity record on the room actor.
- **Inventory.** Per-player. Pickup is a room-to-player saga.
- **Win condition.** Optional. The tutorial doesn't need one; "find
  the staircase down" is a cheap milestone.

## Actor topology

```
World
 ├── Dungeon              (one per active dungeon instance)
 │    ├── Room (×N)       (one actor per room — the unit of simulation)
 │    │     └── entities  (mobs, items: room-state, not separate actors)
 │    └── catalog         (room → neighbors graph)
 ├── Player (×N)          (one actor per logged-in player)
 │     └── currentRoomId
 │     └── inventory
 ├── Merchant (×N)        (one actor per named merchant — chapter 10)
 │     └── inventory      (single source of truth; the merchant may
 │                         appear in multiple rooms simultaneously)
 └── Party (×N)           (ephemeral group actor — chapter 15)
       └── members[]
       └── loot rules
```

A few decisions baked into the topology:

- **Mobs and items are room-state**, not separate actors. Keeps the
  per-tick simulation atomic inside one actor and avoids saga
  overhead for the dominant case ("a mob takes one step").
- **Merchants are separate actors** even though most mobs aren't.
  Garrick-the-merchant has _identity_ that outlives any particular
  room appearance, and his inventory is shared across appearances —
  buying his last sword in room A had better make it unavailable in
  room B. Cross-location shared identity is exactly what a single-
  writer actor was made for.
- **Parties are separate actors** because multiple players need to
  write to the same group state concurrently (joining, leaving,
  rolling for loot). The mailbox is the lock — no application-level
  coordination required.
- **Bosses, world bosses, quests, auction houses** etc. are
  bonus-chapter material; see the Pattern catalog at the bottom for
  how each maps to a named pattern.

## Chapter list

Each chapter has:

- **Goal:** what the reader can do at the end.
- **Concepts:** the actjs primitives introduced.
- **Deliverable:** the runnable artifact.

- **Part I (01–04)** — single-player, single-room, no-movement game
  that renders.
- **Part II (05–06)** — real-time multiplayer in one room.
- **Part III (07–09)** — the rest of the world: player actor, room
  transitions, full multi-room dungeon.
- **Interlude** — _Choosing actor granularity_ names the patterns
  the next chapters introduce.
- **Part IV (10–15)** — cross-actor patterns + polish: Merchant,
  mobs, auth, capabilities, reminders, Party.
- **Part V (16–18, optional)** — event-sourced replay, rate limits,
  production checklist.

The Merchant chapter (10) and Party chapter (15) are the two
cross-actor pattern chapters in the main spine. Everything else in
the **Pattern catalog** below is a one-page sketch showing how the
named pattern maps to additional features readers might want.

### Part I — Foundation

#### 01 — Setup

- **Goal:** scaffold a project that imports actjs, runs `docker
compose up`, and serves a "Hello, dungeon" HTTP endpoint.
- **Concepts:** project layout, `MemoryStorageDriver` for dev,
  `Runtime`, `buildApp`.
- **Deliverable:** `pnpm dev` boots; `curl localhost:3000/v1/health`
  returns 200.

#### 02 — The Room actor

- **Goal:** a `Room` class with a fixed 20×20 grid baked in. Create
  one via REST, read its snapshot.
- **Concepts:** `Actor<S>`, `@handler('read')`, `onInit`,
  `runtime.register`, the REST routes that come for free.
- **Deliverable:** `curl POST /v1/actors/Room` mints a room; `GET
/v1/actors/Room/<id>` returns the tile grid as JSON.

#### 03 — Procgen on `onInit`

- **Goal:** `Room.onInit({seed})` generates a deterministic 20×20
  tile interior and stores it in `state.tiles`.
- **Algorithm:** **drunkard's walk.** ~20 lines: start at the
  center, randomly walk N steps stamping floor tiles, mark
  everything else as wall, post-pass widens narrow corridors.
  Single connected region by construction, visibly random,
  tunable via `(seed, steps, branchProbability)`. Briefer
  alternatives (BSP, rooms-and-corridors, cellular automata) live
  in a "further reading" appendix linking to Bob Nystrom's
  roguelike articles and the roguelike wiki.
- **Concepts:** deterministic seeding, why procgen lives in
  `onInit` (frozen-after-generation invariant), snapshot
  durability.
- **Sidebar:** _"Tired of regenerating dungeons after every
  server restart? Skip ahead to ch 18's PG swap — it's a 3-line
  change."_ The reader doesn't have to take the detour to keep
  going; the sidebar exists so they know the escape valve is
  there.
- **Deliverable:** two requests with the same seed produce the
  same dungeon; the dungeon survives within a session.

#### 04 — Browser renderer

- **Goal:** a static HTML page fetches the snapshot and draws the
  grid in `<canvas>` using Unicode glyphs (🧙 player, 🗡️
  merchant, 🐀 rat, ▓ wall, · floor, ▒ door). No asset pipeline,
  no sprite engine — ~50 lines of canvas rendering.
- **Concepts:** REST `GET /v1/actors/...`, drawing tiles, why
  top-down beats isometric for tutorial legibility (depth sorting
  - sprite stacking are their own rabbit hole). Phaser / PixiJS
    is explicitly out of scope here — see bonus chapter **X3** for
    a renderer swap that touches no server code.
- **Deliverable:** open `index.html`, see a procedurally
  generated dungeon rendered.

### Part II — Real-time, one room

#### 05 — Click-to-move + server pathfinding

- **Goal:** click a tile; the player walks to it.
- **Concepts:** `@handler('move')`, A\* on the room's grid as a
  pure server-side function, `pathChosen` event in state. The
  realtime "tick" loop via `actjs.scheduleAt('tick', now + 200ms)`
  that advances every moving entity one tile per call.
- **Deliverable:** the player's `@` walks from current tile to the
  clicked tile, one tile per 200 ms. The browser re-fetches the
  snapshot each tick to see the move (we'll fix the polling in 06).

#### 06 — Subscriptions: stop polling

- **Goal:** drop the polling. The browser opens a WebSocket, calls
  `actor.subscribe(Room, id)`, and re-renders on each
  `actor.event` notification.
- **Concepts:** `@jplevyak/actjs/client`, WS multiplexing, RFC 6902 patches
  (SWM), the initial-snapshot-then-patches contract.
- **Deliverable:** moves render at tick rate, no polling. Two
  browser tabs see each other move in real time.

### Part III — More than one room

#### 07 — Player actor

- **Goal:** per-logged-in-player actor that owns inventory and
  `currentRoomId`. Replace the anonymous `@` with a named player.
- **Concepts:** a second actor class, cross-actor RPC via
  `this.actjs.call(...)`, the wire-side login flow (mock with a
  fixed dev principal for now; `Principal` arrives in chapter 11).
- **Deliverable:** logging in returns your player id; your stuff
  follows you between sessions.

#### 08 — Room transitions

- **Goal:** walking onto a door tile transfers the player into the
  neighbouring room.
- **Concepts:** the room-transition saga (remove-from-old, update
  player, add-to-new), idempotency keys for retry safety, the
  "no atomic-across-actors transactions" rule and why sagas are
  the answer.
- **Deliverable:** the player can walk through doors. Their entity
  appears in the new room's broadcasts and disappears from the old
  one's.

#### 09 — Procgen graph of rooms

- **Goal:** a `Dungeon` actor pre-generates the room graph (`room
→ neighbors[]`) and lazily mints `Room` actors as players enter
  them.
- **Algorithm:** **grid placement + minimum spanning tree.**
  Drop N rooms at random points on a coarse grid; build a
  minimum spanning tree to connect every room with at least one
  neighbor; sprinkle a few extra edges so the layout isn't a
  pure tree. ~40 lines. Per-room interior procgen (ch 03) runs
  separately as each `Room` actor activates.
- **Concepts:** lazy materialization of actors, a top-level
  `Dungeon` actor coordinating a fleet of room actors, why
  "generate all rooms up front" is wasteful and how lazy
  creation fixes it. The two-level procgen story (dungeon graph
  here, room interiors in ch 03) is itself a teaching moment:
  the right boundary for each algorithm is the actor that owns
  the output.
- **Deliverable:** a full multi-room dungeon. Players walking
  through doors materialize new rooms on first touch.

### Interlude — Choosing actor granularity

Two pages. Not a code chapter — a design framework that names the
patterns the rest of the tutorial uses, so readers can apply them
to their own domain instead of cargo-culting the dungeon.

- **Goal:** the reader can answer "should this be its own actor?"
  for a feature in their own game.
- **Concepts:** the trade-off matrix —
  - Make it an actor when: you need serial writes for correctness,
    its lifetime is independent of any other actor, or other actors
    need to subscribe to it.
  - Make it state inside a parent actor when: it only exists in the
    context of that parent, all writes naturally serialize through
    that parent's mailbox, or the failure mode of a separate actor
    (saga complexity, cross-actor consistency) outweighs the win.

  Then the eight named patterns — each with the dungeon-game
  instance the reader has just built or will build, plus one or two
  recognizable analogues so the pattern lands beyond fantasy RPGs:
  - **Cross-location shared identity** (ch 10 — **Merchant**).
    Garrick has one inventory but appears in multiple rooms; the
    actor _is_ the identity, the rooms hold projections. Same shape
    as: a shared printer's job queue surfacing in every floor's
    print panel; a help-desk agent who's logged into three chat
    rooms at once.
  - **N-way collaborative write** (ch 15 — **Party**). Multiple
    players write to the same group state concurrently; the
    mailbox is the lock. Same shape as: a shared shopping cart,
    collaborative document section, a chat channel.
  - **Cross-location movement** (P1 — **Boss**). One entity that
    moves between containers (rooms). Two actors stay synced via
    a remove-here / add-there saga. Same shape as: a delivery
    truck moving between hubs, a ticket reassigned between
    queues.
  - **Tightly-contested singleton** (P2 — **Auction house**). One
    hot key, many concurrent writers, single-writer correctness
    by construction. Same shape as: limited-edition drop, seat
    reservation, a unique resource lock.
  - **Cross-room event aggregation** (P3 — **Quest**). Many
    rooms tell-and-forget into one coordinator that aggregates
    progress. Same shape as: a leaderboard, a global counter
    (page views, signups), an alerting rule that fires once N
    services report errors.
  - **Player-owned auxiliary** (P4 — **Bank / storage**).
    Per-player but separate from the Player actor because the
    access pattern is different. Same shape as: a user's mailbox,
    drafts folder, photo album — owned by them, lazily loaded,
    not on the hot path.
  - **Time-driven world entity** (P5 — **World boss**). An actor
    that wakes itself via durable reminders independent of any
    user request. Same shape as: weather / day-night cycle,
    daily-challenge generator, a cron-driven report.
  - **Ephemeral coordinator** (P6 — **Trade window**). Born for
    one interaction, tombstoned after. Same shape as: a video
    call, a multi-step checkout session, a pull-request review
    thread that closes when the PR merges.

- **Deliverable:** none — this is the conceptual interlude. The
  next chapter (Merchant) makes the first pattern concrete.

### Part IV — Cross-actor patterns + polish

#### 10 — Merchants: cross-location shared identity

- **Goal:** a named merchant, Garrick, can appear in multiple rooms
  simultaneously; his inventory is single-source-of-truth across
  all appearances. Buying his last sword in one room makes it
  unavailable in another.
- **Concepts:** **cross-location shared identity** pattern. A
  `Merchant` actor owns the inventory; rooms hold a _projection_
  (a presence record: "Garrick is at tile X in this room") that
  doesn't duplicate inventory. The buy flow is a saga: room calls
  `merchant.buy({item, playerId})`, merchant decrements inventory
  and returns the item, room calls `player.addItem(...)`. Walk
  the reader through the happy path, then the "merchant is sold
  out" failure path and how the saga compensates.
- **Deliverable:** Garrick is in rooms A and B. Two players, one
  in each room, race to buy his last potion. Exactly one
  succeeds; the other sees `OutOfStock`.

#### 11 — Mobs as room-state

- **Goal:** monsters that wander, chase the nearest player, and
  attack on contact.
- **Concepts:** entity AI inside the room actor's tick handler,
  why "mobs as room state" is the right default (everything in one
  tick = one atomic mutation) and a callback to the interlude
  explaining why mobs are room-state but merchants aren't — the
  interlude framework predicts it.
- **Deliverable:** rats. They patrol. They bite. Sometimes they
  win.

#### 12 — Auth + `policy()`

- **Goal:** a player can only move their own character. Merchants
  refuse trades from principals with no inventory room.
- **Concepts:** `Principal`, the BYO `auth(req)` hook, `static
policy(p, action)` on the room actor enforcing "the entity in
  action.args.entityId must belong to the calling player," and on
  the merchant actor enforcing "the buyer principal matches the
  player id in args."
- **Deliverable:** opening the dungeon URL in two browsers under
  two different principals — each can only control their own
  player.

#### 13 — Capability share link

- **Goal:** "share this dungeon" link that lets a friend spectate
  (read-only) without an account.
- **Concepts:** `actjs.mintCapability({methods: ['read'], ttlMs:
… })` inside a handler; presenting the JWT as
  `Authorization: Capability <jwt>`; the capability-only
  `Principal` shape.
- **Deliverable:** share a URL; the recipient sees the dungeon
  live but can't do anything in it.

#### 14 — Reminders for monsters + turn timeouts

- **Goal:** monsters that respawn after 30 s; if a player goes
  AFK in the dungeon for 5 minutes their character sits down.
- **Concepts:** `actjs.scheduleAt` for durable wall-clock timers
  versus the per-tick reminder loop, why durable reminders survive
  server restarts.
- **Deliverable:** kill a rat, wait, it respawns. Leave a tab
  open, watch your character idle.

#### 15 — Parties: N-way collaborative write

- **Goal:** two to four players form a party; loot drops roll for
  the whole party, not just the player who killed the mob; party
  chat appears in every member's UI in real time.
- **Concepts:** **N-way collaborative write** pattern. The `Party`
  actor's mailbox is the lock — multiple players calling
  `party.join`, `party.rollLoot`, `party.chat` at the same time
  are serialized for free, with no Postgres `SELECT ... FOR
UPDATE` or application-level locking. Subscriptions broadcast
  the same patches to every member's WS connection. Callback to
  the interlude: this is a fundamentally different shape from
  the Merchant — same mailbox, different access pattern.
- **Deliverable:** form a party of two browsers, kill a rat
  together, both see the loot roll happen, both see the winner
  pick up the item. Party chat works in both tabs.

### Part V — Production-shape extras (optional)

#### 16 — Event-sourced replay

- **Goal:** `class Dungeon extends EventSourced` so every player
  action becomes a durable event; build a "watch a replay" page.
- **Concepts:** `EventSourced<S, E>`, `reduce`, `migrateEvent`,
  the trade-off between SWM (cheap state, no replay) and ES
  (replayable, audit-grade, every write is two writes).
- **Deliverable:** a replay slider that scrubs through the
  dungeon's history.

#### 17 — Rate limits + active-actor caps

- **Goal:** show the server holding up under a stress test.
- **Concepts:** `RateLimiter` per-principal, per-class
  `activeActorCapPerClass`, the `429 RateLimited` and `503
CapacityExhausted` problem-detail responses, dashboards on the
  shipped Prometheus metrics.
- **Deliverable:** point a load tool at the server, watch the
  dashboards, see backpressure surface as well-formed HTTP errors.

#### 18 — Production checklist (and the PG swap)

- **Goal:** graduate the game from `MemoryStorageDriver` to
  `ValkeyPgStorageDriver` and walk through what an operator
  needs to flip on before running this in front of users.
- **Concepts:** **swapping the storage driver** (3-line change
  at `buildApp` — the whole point is that nothing else moves);
  the strict-mode `Auditor`; capability blocklist; signed
  publishes via `actctl publish --sign`; running migrations
  (`0001_init` through `0004_actor_fence`); the items on the
  [ROADMAP](../tasks/ROADMAP.md) that aren't shipped yet (and
  which of them this game would block on — PG-backed blocklist
  - signing-key registry are the Tier-1 watch list).
- **Deliverable:** the demo runs against
  `ValkeyPgStorageDriver`; dungeons survive a server restart;
  a 1-page printable deployment checklist lives at the end of
  the chapter.
- **Deliverable:** a 1-page deployment checklist; the demo runs
  against `ValkeyPgStorageDriver` instead of the memory driver.

### Pattern catalog (bonus chapter sketches)

Each entry below names a pattern from the **Choosing actor
granularity** interlude, then sketches an instance the reader can
build by extending the dungeon. One page each — these are
"extensions you can write yourself," not full chapter prose. The
patterns introduced in the main spine (Merchant = cross-location
shared identity, Party = N-way collaborative write) are not
repeated here.

- **P1 — Cross-location movement.** Instance: **Boss** that
  wanders between rooms tracking the party. Two actors stay synced
  via a saga: `boss.move()` removes the boss from room A's entity
  list, updates the boss's `currentRoomId`, and adds it to room
  B's entity list. Idempotency keys cover the retry case. The
  fencing-token plumbing from Phase 9 covers concurrent ownership
  attempts (today it never fires; v2 cluster will). Shape is
  similar to the Player room transition saga in chapter 08.

- **P2 — Tightly-contested singleton.** Instance: **Auction
  house** with one item up for bid, three players bidding
  concurrently. The auction actor's mailbox serializes bids; no
  Postgres `SELECT ... FOR UPDATE` needed. Bid race is impossible
  by construction. This pattern is the actjs killer feature; if a
  reader has _one_ takeaway, this should be it.

- **P3 — Cross-room event aggregation.** Instance: **Quest** —
  "kill 10 rats anywhere in the dungeon." When a rat dies in any
  room, the room `tell`s the quest actor; the quest actor
  aggregates and notifies subscribers when complete. Rooms
  tell-and-forget (no waiting); quest is the consistency
  boundary. Also covers leaderboards, bounty boards, achievements.

- **P4 — Player-owned auxiliary.** Instance: **Bank / storage**
  per player. Per-player but separate from the `Player` actor
  because deposit / withdraw are heavyweight operations
  (transactional with the player's inventory) and the access
  pattern is different from "look at the player's stats." Same
  shape as Mailbox / inbox, Spellbook, etc.

- **P5 — Time-driven world entity.** Instance: **World boss**
  that spawns every 12 hours in a random room, broadcasts a
  global notification, despawns after 30 min if not killed. The
  actor wakes itself via durable reminders; reminders survive
  server restarts. Same shape as Weather / day-night cycle, daily
  challenges, server-wide events.

- **P6 — Ephemeral coordinator.** Instance: **Trade window**
  between two players. A `Trade` actor is born when player A
  proposes a trade with player B, lives for the duration of the
  trade (or until one side cancels / times out), then tombstones.
  Each step (offer item, lock-in, confirm) is one mailbox turn.
  Same shape as combat-instance, party-invite, duel.

- **P7 — Lobby + matchmaking** (the original B2, fitting under
  P6). A `Lobby` actor pairs N players, spawns a fresh `Dungeon`
  for the group, and tombstones. Ephemeral coordinator pattern at
  the world-entry layer.

### Non-pattern bonus chapters

These don't fit the pattern catalog — they're framework features
worth a chapter on their own:

- **X1 — Server-rendered hydration.** Use `@jplevyak/actjs/bindings/react/server`
  and `fetchActor(Room, id, {manifest})` for SSR'd cold loads.
  About the SDK, not about actor design.

- **X2 — Migrations in production.** Ship a v2 of the `Room`
  class with a renamed field; walk the reader through
  `actctl migrate dry-run` (when 8.2b ships) or
  `replayMigrations` from `@jplevyak/actjs/test` today. About class-version
  lifecycle, not about actor design.

- **X3 — Swap the renderer to Phaser (or PixiJS).** Replace the
  ch 04 canvas renderer with a real game engine — sprites,
  animation tweens, camera, particle effects. The server code
  is untouched; the only change is the client-side view layer.
  Demonstrates that actjs is renderer-agnostic and gives readers
  who want a polished result an upgrade path. About the client,
  not about actor design.

## Constraints + tone

- **Keep each chapter under an hour of reading + coding.** If
  something blows past, split it.
- **Show the actjs concept first, then the gameplay.** Every
  chapter title is a primitive, the dungeon is the excuse.
- **Canvas + Unicode glyph renderer by default.** ~50 lines, no
  asset pipeline, no game engine. Phaser / PixiJS as a renderer
  swap in bonus chapter X3 — the server doesn't move.
- **`MemoryStorageDriver` throughout the main spine** (chapters
  01–17). Chapter 18 graduates to `ValkeyPgStorageDriver`. A
  sidebar in ch 03 points readers at the swap if they get tired
  of regenerating dungeons.
- **One server process throughout.** No clustering. Phase 9 is
  explicitly out of scope.
- **No build-step magic.** Vite or esbuild for the browser bundle;
  `tsx` for the server. The tutorial is about actjs, not about
  configuring tooling.

### Repo layout + packaging

- **Single linear `main` branch** carries the canonical code.
  No per-chapter branches (UX disaster at 18 entries; cross-
  references rot). No `chapters/01-setup/` directory
  duplication (drift; 16× bytes).
- **Per-chapter tags** `ch01-done` through `ch18-done` mark
  the state at the end of each chapter. Readers jump in via
  `git checkout ch07-done`; readers comparing chapters use
  `git diff ch03-done ch05-done`.
- **Tutorial prose under `tutorial/chapters/01-setup.md`,
  `02-room.md`, …**. Stable file paths; prose links into
  `main` once and stays correct as later chapters extend the
  code.
- **`tutorial/README.md` (this file)** is the outline /
  table of contents; it links into the chapter files and the
  tag index.

## Out of scope (call out explicitly)

- **Continuous-control / WASD movement.** Anti-pattern at this
  scale; would force per-frame intent messages and fight the
  mailbox. Stick to click-to-move.
- **PvP combat balancing.** The tutorial models bump-attack with
  a static damage formula. Balance is somebody else's problem.
- **Account systems, payments, anti-cheat.** Each is its own
  rabbit hole.
- **Native iso renderer.** Mentioned in chapter 04 as a
  bring-your-own swap; top-down stays the default.

## Decisions log

Settled 2026-05-21:

- **Renderer.** Plain canvas + Unicode glyphs by default; Phaser
  / PixiJS as bonus chapter X3 (renderer swap, server untouched).
- **Procgen.** Drunkard's walk for per-room interiors (ch 03);
  grid placement + minimum spanning tree for the dungeon graph
  (ch 09). Further-reading appendix points at BSP, cellular
  automata, Wave Function Collapse.
- **Persistence.** `MemoryStorageDriver` throughout the main
  spine; `ValkeyPgStorageDriver` arrives in ch 18 as the
  headline event of the production-checklist chapter. Sidebar
  in ch 03 names the escape valve for readers who want it
  sooner.
- **Packaging.** Single linear `main` branch + per-chapter
  tags `ch01-done` through `ch18-done`. Prose in
  `tutorial/chapters/NN-name.md` links into stable `main`
  paths.

## Next step

Open questions are settled. Write **chapter 01** (`tutorial/chapters/01-setup.md`)
end to end and tag `ch01-done` against the resulting `main`
state. Iteration on the outline gets cheaper once one chapter is
fully drafted, and any wobble in the four decisions above shakes
out on a real chapter rather than in the abstract.
