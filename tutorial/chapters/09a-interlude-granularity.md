# Interlude — Choosing actor granularity

> **Not a code chapter.** This is a design framework that names
> the patterns the rest of the tutorial uses, so you can apply
> them to your own domain instead of cargo-culting the dungeon
> game.
>
> **Time budget:** 10 minutes of reading.
>
> **No tag, no code, no deliverable** — but the next nine
> chapters lean on the vocabulary established here.

---

You've reached the end of Part III with three actor classes —
`Room`, `Player`, `Dungeon` — and a working multi-room dungeon
crawler. Part IV starts introducing more actor types, and before
that lands you should have an answer to the single hardest
design question in actjs: **when does a thing deserve to be its
own actor, and when does it belong inside another one?**

The cost of getting this wrong cuts both ways. Too few actors
and a single mailbox becomes the bottleneck for everything; the
"single-writer-mailbox" guarantee, which was a feature when
boundaries fit, becomes a serialization tax. Too many actors and
every user action turns into a saga across a dozen mailboxes,
each with its own consistency window and its own failure mode.

There's no universal answer. There's a checklist, and a small
catalog of patterns that map common gameplay (or non-game)
shapes to the right granularity. This interlude provides both.

## The checklist

Three questions. If the answer to **any one of them** is "yes,"
make it an actor:

1. **Do you need serial writes for correctness?** If multiple
   callers will concurrently mutate the same state and the
   mutations must not interleave, you want the mailbox as your
   lock. Example: an auction with many bidders, an inventory
   under contention, a counter that must increment exactly
   once per event.
2. **Does its lifetime outlive any single parent?** If the
   thing needs to exist independently of whichever room /
   player / session created it, it's its own actor. Example: a
   guild that survives all members logging off, a quest that
   tracks progress across rooms, a player that walks between
   rooms.
3. **Do other actors need to subscribe to it?** If clients (or
   other actors) want a real-time feed of its state changes,
   subscriptions terminate at actor boundaries. A field on
   another actor's state can't be subscribed to independently;
   a separate actor can.

Three questions, three independent reasons. The Player actor
from chapter 07 passes (2) and (3); the Merchant from chapter
10 passes all three.

If **all three answers are "no,"** the thing should be state
inside a parent actor instead. The mobs from chapter 11 are the
canonical example: their lifetime is tied to their room, only
their room writes to them (the tick handler), and nothing
subscribes to one mob separately from its room.

## When _not_ to make it an actor

The reverse failure mode is easier to do accidentally. Every
new actor adds:

- **Mailbox round-trips.** A cross-actor call is a mailbox turn
  on the target actor; with many fine-grained actors,
  user-visible latency turns into "sum of mailbox queue times
  across N actors."
- **Saga complexity.** Mutating two actors atomically isn't
  possible; you have to design a sequence of idempotent steps
  with compensation on failure (chapter 08, chapter 10). The
  more actors a user action crosses, the more sagas you write.
- **No transactional consistency.** Two actors can hold
  invariants that briefly contradict each other in the middle
  of a saga. Often fine, sometimes catastrophic; you have to
  reason about it.

The fix is the checklist above: if you can't say yes to one of
the three questions, your "actor" probably wants to be a field
on a parent. Three similar lines of code is better than a
premature actor.

## The pattern catalog

Eight patterns the rest of the tutorial uses. Each entry names
the dungeon-game instance you'll write (or have written), plus
one or two recognizable analogues so the pattern stays useful
outside fantasy RPGs.

### 1. Cross-location shared identity

The actor _is_ the identity; other actors hold projections of
it. The state lives once; the projections never duplicate it.

- **Dungeon game:** **Merchant** (chapter 10). Garrick has one
  inventory. He appears in rooms `(0, 0)` and `(2, 2)`. The
  rooms hold a "presence record" (he's here, at tile X) but
  not his inventory.
- **Outside the dungeon:** a shared printer's job queue
  surfacing in every floor's print panel; a help-desk agent
  who's logged into three chat rooms at once; a Slack bot
  that's a member of many channels but has one rate-limit
  counter.

The checklist verdict: serial writes ✓ (concurrent buys),
lifetime ✓ (outlives any room), subscription target ✓
(inventory feed). Three yeses.

### 2. N-way collaborative write

Multiple peers write to the same group state concurrently. The
mailbox is the lock — without it you'd need a Postgres
`SELECT ... FOR UPDATE` per write.

- **Dungeon game:** **Party** (chapter 15). 2–4 players join a
  party; loot drops roll across the whole party; party chat
  appears in every member's UI.
- **Outside the dungeon:** a shared shopping cart, a
  collaborative document section, a chat channel, a draft
  Google Doc, a Trello board column being reordered by three
  people at once.

This is the pattern actjs was practically invented for. The
race correctness comes free; the rest is just defining the
group's state shape and which writes mutate it.

### 3. Cross-location movement

One entity that moves between containers, with two actors
needing to stay in sync about which container holds it.

- **Dungeon game:** **Boss** (Pattern P1 in the bonus
  catalog). A unique mob that wanders between rooms tracking
  the party. Two actors (old room, new room) stay synced via
  a remove-here / add-there saga.
- **Outside the dungeon:** a delivery truck moving between
  hubs; a customer-support ticket reassigned between queues;
  a server VM being migrated between hosts.

Players walking between rooms (chapter 08) is a related but
simpler shape — the Player actor carries the "where am I?"
state, so there's no second-actor sync problem.

### 4. Tightly-contested singleton

One hot key, many concurrent writers, single-writer correctness
by construction. The actor is the entire purpose of the
pattern: there's nothing else to it.

- **Dungeon game:** **Auction house** (Pattern P2 in the bonus
  catalog). One actor per active auction; many players bid;
  exactly one wins.
- **Outside the dungeon:** a limited-edition drop, a seat
  reservation system, a "first to claim wins" coupon code,
  the `INSERT ... ON CONFLICT` that you'd otherwise write
  for the same job.

This is _the_ actjs killer feature against a Postgres-backed
service. The other service would need explicit locking, retry
loops, or a queue. The actor needs none of those.

### 5. Cross-room event aggregation

Many emitting actors tell-and-forget into one coordinator that
aggregates. The coordinator owns the running tally; the
emitters never know about each other.

- **Dungeon game:** **Quest** (Pattern P3 in the bonus
  catalog). "Kill 10 rats anywhere in the dungeon" — every
  room that has a rat death tells the quest actor, which
  counts.
- **Outside the dungeon:** a leaderboard, a global counter
  (page views, signups), an alerting rule that fires once N
  services report errors, a fan-in metric.

The emitters use `tell` (fire-and-forget) — they don't wait for
the aggregator. Latency stays low; the aggregator catches up at
its own pace.

### 6. Player-owned auxiliary

Per-player but separate from the Player actor because the
access pattern is different.

- **Dungeon game:** **Bank / storage** (Pattern P4 in the
  bonus catalog). Each player has a bank actor where they
  stash items outside their carry inventory.
- **Outside the dungeon:** a user's mailbox, drafts folder,
  photo album — owned by them, lazily loaded, off the hot
  path of "what's the user looking at right now."

The Player actor is the hot path: it has the current room id,
the score, the active equipment. The auxiliary actors are
warm-but-not-blocking: deposits and withdraws happen at human
speed, not per-tick.

### 7. Time-driven world entity

An actor that wakes itself via durable reminders independent of
any user request. The reminder loop pattern from chapter 05
generalizes here.

- **Dungeon game:** **World boss** (Pattern P5 in the bonus
  catalog). Spawns every 12 hours in a random room,
  broadcasts a global notification, despawns after 30 minutes
  if not killed.
- **Outside the dungeon:** weather / day-night cycle, a
  daily-challenge generator, a cron-driven report, a stale-
  cache sweeper.

The actor never receives user-initiated traffic. It exists
because `setInterval` outside the mailbox doesn't survive
restarts; the actor pattern does.

### 8. Ephemeral coordinator

Born for one interaction, tombstoned after.

- **Dungeon game:** **Trade window** (Pattern P6 in the bonus
  catalog). Player A proposes a trade with Player B; a `Trade`
  actor is born, lives for the duration of the trade (or
  until one side cancels / times out), then tombstones.
- **Outside the dungeon:** a video call, a multi-step
  checkout session, a pull-request review thread that closes
  when the PR merges, a one-time-password challenge.

The ephemerality is the point. The actor exists because the
interaction needs durable state for its lifetime — but
forever-living entities (Players, Rooms) shouldn't carry that
state because it's stale ten seconds later.

## Mapping the checklist to the catalog

A quick way to remember which question pushes you toward which
pattern:

| If your top reason is...           | The pattern is likely...                                           |
| ---------------------------------- | ------------------------------------------------------------------ |
| Concurrent writes need serializing | (4) Tightly-contested singleton, or (2) N-way collaborative write  |
| Identity outlives the parent       | (1) Cross-location shared identity, or (3) Cross-location movement |
| Subscription target                | (5) Cross-room event aggregation, or (6) Player-owned auxiliary    |
| Self-scheduled lifecycle           | (7) Time-driven world entity, or (8) Ephemeral coordinator         |

This is rough — most patterns hit multiple checklist boxes —
but the table helps when you're staring at a domain object and
asking yourself "is this actor-shaped or struct-shaped?"

## What's next

Chapter 10 (Merchant) implements pattern (1) — the canonical
cross-location identity. Chapter 11 (Mobs as room-state) is the
deliberate _opposite_: state inside a parent actor, because
mobs fail all three checklist questions. Chapter 15 (Party)
implements pattern (2). The remaining patterns live as
one-page sketches in the bonus catalog after chapter 18; pick
the ones that fit your own game.

When you write your own actors, walk the checklist out loud
before reaching for `new`-ing up an actor class. If you can't
say "yes" to at least one of the three questions, it's a
field on a parent. Three similar lines of code are still better
than a premature actor.
