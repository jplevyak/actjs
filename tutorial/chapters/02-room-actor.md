# Chapter 02 — The Room actor

> **Chapter goal:** define your first actor class, register it
> with the runtime, mint one over REST, and read its state back.
> The dungeon stays a static 20×20 box for now — procgen is the
> next chapter.
>
> **Time budget:** ~40 minutes.
>
> **End-of-chapter tag:** `ch02-done`.

---

Chapter 01 stood up a server with no actors. This chapter writes the
first one. Once it's registered with the `Runtime`, the REST routes
for `Room` light up automatically — there's no per-method route
registration to do.

By the end of this chapter you will:

- Have a `Room` actor class with a typed `state` shape.
- Understand `Actor<S>`, `onInit`, `@handler`, and
  `runtime.register(...)`.
- Know which HTTP routes actjs wires for every registered actor
  class, and what each one does.
- Be able to `curl POST /v1/actors/Room` to mint a room, then
  read its state with either a `read` handler call or the raw
  snapshot route.

## What's an actor, concretely

In actjs, an **actor** is a TypeScript class with three things:

1. A `state` field with a typed shape — the actor's durable
   memory.
2. Lifecycle hooks (`onInit`, optionally `onActivate` /
   `onDeactivate`) that the runtime calls at well-defined moments.
3. Zero or more `@handler`-decorated methods that the outside
   world can invoke.

The runtime guarantees that **only one handler runs at a time
per actor instance**. That's the single-writer-mailbox property
the framework is built around: you never have to think about
locking inside an actor's code because the mailbox is the lock.

Concretely, you'll be writing classes that look like:

```ts
class Room extends Actor<RoomState> {
  override onInit(): void {
    /* set this.state */
  }
  @handler() // string arg is optional; defaults to the method name
  something(args: Args): Result {
    /* read + write this.state, return something */
  }
}
```

That's the entire shape. Everything else in this chapter is wiring.

## Define the state shape

Make a new file `src/room.ts`:

```ts
import { Actor } from '@jplevyak/actjs/actor';
import { handler } from '@jplevyak/actjs/handler';

const WIDTH = 20;
const HEIGHT = 20;

/**
 * Every tile is one character. `#` is a wall, `.` is floor, `+` is
 * a door. We store the grid as 20 strings of length 20 — easy on
 * the eyes when you dump the snapshot as JSON, and a clean separation
 * between the symbolic representation here and whatever the renderer
 * decides to draw (chapter 04).
 */
export interface RoomState {
  readonly width: number;
  readonly height: number;
  /** `tiles[y]` is one row of length `width`. */
  readonly tiles: readonly string[];
}

export class Room extends Actor<RoomState> {
  override onInit(): void {
    this.state = {
      width: WIDTH,
      height: HEIGHT,
      tiles: buildEmptyRoom(WIDTH, HEIGHT),
    };
  }

  /**
   * Return the whole state. This is the canonical "give me the
   * room" call — chapter 04's browser renderer will hit this on
   * page load, then switch to a WS subscription for live updates
   * in chapter 06.
   */
  @handler()
  read(): RoomState {
    return this.state;
  }

  /**
   * Single-tile read. Demonstrates a handler with typed args and a
   * narrower return shape. You don't need this for ch 03 / ch 04,
   * but it's useful for sanity checks while we don't have a
   * renderer yet.
   */
  @handler()
  tileAt(args: { x: number; y: number }): string {
    const row = this.state.tiles[args.y];
    if (!row || args.x < 0 || args.x >= this.state.width) {
      throw new Error(`out of bounds: (${args.x}, ${args.y})`);
    }
    return row[args.x] ?? '?';
  }
}

/** Walls around the edge, floor everywhere else, single door north. */
function buildEmptyRoom(w: number, h: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) {
      const onEdge = x === 0 || x === w - 1 || y === 0 || y === h - 1;
      const isNorthDoor = y === 0 && x === Math.floor(w / 2);
      row += isNorthDoor ? '+' : onEdge ? '#' : '.';
    }
    rows.push(row);
  }
  return rows;
}
```

A few specifics worth pausing on:

- **`Actor<RoomState>`**. The generic parameter is the state
  shape. The runtime materializes `this.state` from a persisted
  snapshot when the actor activates; you never call `loadSnapshot`
  yourself.
- **`override onInit(): void`**. Fires exactly once, on cold
  start (no snapshot exists). This is where you seed `state`. If
  the actor restarts later, `state` is loaded from the snapshot
  and `onInit` does **not** run again. That's the
  frozen-after-generation invariant chapter 03 relies on for
  procgen.
- **`@handler()`**. The string argument is optional — when omitted,
  the decorator uses the method's declared name as the wire name.
  Pass an explicit string only when you want the two to diverge
  (e.g. `@handler('tile_at')` on a method named `tileAt`).
  We don't need that here, so we leave the parens empty.
- **`readonly` everywhere on `RoomState`**. actjs doesn't enforce
  immutability — but writing state as if it were immutable keeps
  the SWM contract honest: the only way state changes is through
  a handler returning a new value (or, idiomatically for actjs,
  mutating `this.state` directly inside a handler, which the
  framework snapshots after the handler returns).

## Register the class

Open `src/server.ts` and add the `Room` registration. The full
file now reads:

```ts
import { Runtime } from '@jplevyak/actjs/runtime';
import { buildApp } from '@jplevyak/actjs/server';
import { MemoryStorageDriver } from '@jplevyak/actjs/storage';

import { Room } from './room.js';

const driver = new MemoryStorageDriver();
await driver.init();

const runtime = new Runtime(driver);

// Register the Room class with the runtime. After this line, the
// HTTP server exposes /v1/actors/Room and friends.
runtime.register({
  name: 'Room',
  version: '1.0.0',
  ctor: Room,
});

const app = await buildApp({ driver, runtime });

const port = Number(process.env['PORT'] ?? 3000);
await app.listen({ port, host: '0.0.0.0' });

console.log(`dungeon: listening on http://localhost:${port}`);
console.log(
  `dungeon: try \`curl -X POST http://localhost:${port}/v1/actors/Room -d '{}' -H 'content-type: application/json'\``,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      console.log(`dungeon: received ${signal}, draining…`);
      await app.close();
      await runtime.shutdown();
      await driver.close();
      process.exit(0);
    })();
  });
}
```

The new pieces:

- **`runtime.register(...)`** registers exactly one class at one
  version. You can register multiple classes (we will in ch 07
  for `Player`), and the same class at multiple versions
  (chapter 03 stays at `1.0.0`; later chapters might bump). For
  now, one `Room` at `1.0.0` is everything we need.
- **Why `name` is explicit rather than derived from `ctor.name`.**
  Bundlers mangle class names during minification — `Room` becomes
  `a` or `r` in a production build, so `ctor.name` is unreliable.
  More importantly, `name` is the durable key under which all
  snapshots are stored; it has to be a stable, intentional string,
  not something that silently changes when you rename a class or
  re-bundle.

## Run it

```bash
pnpm dev
```

The server should boot exactly as before. The big change is
invisible: the routes for `Room` are now live.

## Mint a room

In a second terminal:

```bash
ID=$(curl -s -X POST http://localhost:3000/v1/actors/Room \
  -H 'content-type: application/json' \
  -d '{}' | jq -r .id)

echo "$ID"
# → 019e4a2b-1234-7abc-9def-456789abcdef  (a UUIDv7)
```

`POST /v1/actors/Room` allocates a fresh actor id and returns
it. The actor isn't materialized yet — actjs is lazy. Until you
invoke a handler, no `Room` instance exists in memory, no
snapshot has been written, and `onInit` hasn't fired.

Verify the lazy state. Try the raw snapshot route:

```bash
curl -i http://localhost:3000/v1/actors/Room/"$ID"
# → HTTP/1.1 404 Not Found
# → application/problem+json
# → { "type": "...", "title": "ActorNotFound", ... }
```

That's actjs telling you: this actor id is real, but it has no
durable state yet. Calling any handler will materialize it.

## Read its state

```bash
curl -s -X POST http://localhost:3000/v1/actors/Room/"$ID"/read \
  -H 'content-type: application/json' \
  -d '{}' | jq
```

You should see:

```json
{
  "class": "Room",
  "id": "019e4a2b-...",
  "method": "read",
  "result": {
    "width": 20,
    "height": 20,
    "tiles": [
      "##########+#########",
      "#..................#",
      "#..................#",
      "#..................#",
      "#..................#",
      "#..................#",
      "#..................#",
      "#..................#",
      "#..................#",
      "#..................#",
      "#..................#",
      "#..................#",
      "#..................#",
      "#..................#",
      "#..................#",
      "#..................#",
      "#..................#",
      "#..................#",
      "#..................#",
      "####################"
    ]
  }
}
```

There's your dungeon. Walls (`#`) around the edge, floor (`.`)
inside, a door (`+`) at the top.

Three things happened on that one POST:

1. The runtime saw no live host for this id, so it
   **materialized** one — instantiated `new Room()`, ran
   `onInit()`, and attached it to the directory.
2. `read()` ran in a mailbox turn — the single-writer guarantee
   applies even on the first call.
3. After the handler returned, the runtime scheduled a snapshot
   write. The default debounce is 250 ms — short enough that a
   follow-up snapshot read picks up the state, long enough that
   bursty writes coalesce.

Confirm point 3:

```bash
sleep 1
curl -s http://localhost:3000/v1/actors/Room/"$ID" | jq
```

This time the raw snapshot route works:

```json
{
  "class": "Room",
  "id": "019e4a2b-...",
  "version": "1.0.0",
  "seq": "0",
  "state": { "width": 20, "height": 20, "tiles": ["##...", ...] }
}
```

`seq` is `0` because the room is a SWM actor with no event log
(we'll see `seq` grow in chapter 14 when we make the dungeon
event-sourced). `version` came back as `1.0.0` because that's
what `runtime.register` declared.

## Call the typed handler

Try `tileAt`:

```bash
curl -s -X POST http://localhost:3000/v1/actors/Room/"$ID"/tileAt \
  -H 'content-type: application/json' \
  -d '{ "x": 0, "y": 0 }' | jq -r .result
# → "#"

curl -s -X POST http://localhost:3000/v1/actors/Room/"$ID"/tileAt \
  -H 'content-type: application/json' \
  -d '{ "x": 5, "y": 5 }' | jq -r .result
# → "."

curl -s -X POST http://localhost:3000/v1/actors/Room/"$ID"/tileAt \
  -H 'content-type: application/json' \
  -d '{ "x": 10, "y": 0 }' | jq -r .result
# → "+"
```

A handler that throws becomes a structured HTTP error. Try an
out-of-bounds request:

```bash
curl -i -X POST http://localhost:3000/v1/actors/Room/"$ID"/tileAt \
  -H 'content-type: application/json' \
  -d '{ "x": 99, "y": 99 }'
# → HTTP/1.1 500 Internal Server Error
# → application/problem+json
# → { "type": ".../InternalError", "title": "Error",
# →   "detail": "out of bounds: (99, 99)", "code": "InternalError" }
```

Chapter 12 will replace that 500 with a typed 400 by introducing a
domain error class, but the RFC 7807 envelope is already in place.

## Tour: what routes did you get for free

`runtime.register(Room)` lit up the following routes. Every line
came from a single `runtime.register` call:

| Verb     | Path                          | What it does                                                                 |
| -------- | ----------------------------- | ---------------------------------------------------------------------------- |
| `POST`   | `/v1/actors/Room`             | Mint a fresh actor id; lazy until first handler call.                        |
| `POST`   | `/v1/actors/Room/:id/:method` | Invoke a `@handler`-decorated method. Body is the args object.               |
| `GET`    | `/v1/actors/Room/:id`         | Raw snapshot from the durable store. `ActorNotFound` until materialized.     |
| `DELETE` | `/v1/actors/Room/:id`         | Tombstone the actor. Snapshots + events remain for audit; the actor is gone. |

Plus everything that came in chapter 01: `/v1/health`,
`/openapi.json`, `/v1/classes`, the manifest pin hook, the
idempotency hook, RFC 7807 error mapping.

Try the OpenAPI document again:

```bash
curl -s http://localhost:3000/openapi.json | jq '.paths | keys'
```

You'll now see the `Room` routes listed alongside the framework's
own. The schema for the `read` and `tileAt` handlers is **not**
inferred yet — we'll fix that in chapter 06 once `actctl codegen`
generates the typed client bundle. For now the body is `unknown`
on the wire.

## Commit + tag

```bash
git add .
git commit -m "ch02: define Room actor; register with runtime"
git tag ch02-done
```

## Recap

You learned five things, in this order:

1. **`Actor<S>`** carries a typed `state` field. The runtime
   loads it from a snapshot on activation; you never touch the
   driver directly.
2. **`onInit`** is the cold-start hook. It fires exactly once
   per actor lifetime. Subsequent activations (after server
   restarts, idle eviction, etc.) reuse the persisted snapshot.
3. **`@handler()`** registers a method as wire-callable. The string
   argument is optional and defaults to the method name; pass one
   only when you want the wire name to differ. The mailbox
   guarantees serial execution — one handler turn at a time per
   actor instance.
4. **`runtime.register({name, version, ctor})`** is the one
   place you wire a class into the runtime. The HTTP layer
   does the rest.
5. **Actors are lazy.** A POST to `/v1/actors/Room` allocates
   an id but doesn't materialize the actor. The first handler
   call brings it to life.

The handful of design choices baked into this chapter — `tiles`
as a `readonly string[]`, walls-and-door bake-in, the `read` +
`tileAt` pair — are all sized to disappear in the next chapter.
Procgen replaces `buildEmptyRoom`; the renderer in chapter 04
maps `'#'` and `'.'` to Unicode glyphs. The handler shape is the
permanent thing.

## What's next

In **chapter 03 — Procgen on `onInit`**, we'll swap
`buildEmptyRoom` for a deterministic seed-driven dungeon
generator (drunkard's walk). The class shape doesn't change.
Two requests with the same seed will produce the same dungeon;
two requests with different seeds will produce visibly
different ones.

---

## Troubleshooting

**`POST /v1/actors/Room` returns 404**

Most likely cause: `runtime.register({...})` is missing or the
`name` doesn't match the URL. The path segment is matched
verbatim — `runtime.register({ name: asClassName('Room'), ... })`
exposes `/v1/actors/Room`, not `/v1/actors/room`.

**`GET /v1/actors/Room/<id>` returns 404 even after a handler call**

The snapshot debounce hasn't fired yet. Default is 250 ms; if
you `curl` immediately after the handler returns, the snapshot
isn't on disk yet. Either `sleep 0.5` or stick to the
`POST /<id>/read` flow, which doesn't depend on the snapshot
having been written.

**`Cannot apply unknown decorator`**

You enabled `experimentalDecorators` in `tsconfig.json`. Turn
it off (or remove the line). `@handler` is a TC39 stage-3
decorator that ships with TypeScript 5 by default.

**State doesn't survive a server restart**

That's expected — you're on the `MemoryStorageDriver`. Restart
loses everything. Chapter 18 swaps in the PG driver; until then
the chapter 03 sidebar shows the early-swap option.

**`tileAt` request body comes back as `undefined`**

Missing `content-type: application/json`. Fastify only parses
JSON when the header says so; without it, the body is treated
as an opaque buffer and the handler sees an empty object.
