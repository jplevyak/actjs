# Chapter 04 — Browser renderer

> **Chapter goal:** show the dungeon in a browser. A static HTML
> page fetches the room's state and draws the grid into a
> `<canvas>` using Unicode glyphs and color. No game engine, no
> asset pipeline, no build step — ~80 lines of vanilla JS.
>
> **Time budget:** ~45 minutes.
>
> **End-of-chapter tag:** `ch04-done`.

---

Three chapters in we have a real dungeon, but you can only see it
as JSON. This chapter renders it. By the end you'll be able to
open `http://localhost:3000/` and see your procgen output as a
grid of colored tiles. Reload the page and you get a stable view
of the same room; clear the URL parameter and you get a fresh
one.

By the end of this chapter you will:

- Have a static `index.html` + `main.js` served from the same
  process as the actjs server.
- Have a ~80-line vanilla-JS renderer that draws the room's tile
  grid in a `<canvas>`.
- Have a URL convention (`?id=<actorId>`) that makes rooms
  bookmarkable and shareable.
- Understand exactly which actjs surface the browser touches —
  spoiler: just `POST /v1/actors/Room` and `POST /<id>/read`,
  both already shipped by `runtime.register(Room)` in chapter 02.

## Why top-down, not isometric

The outline mentioned this in passing; it's worth a paragraph
before we write any code.

**Isometric (2.5D) rendering** — the classic Diablo / SimCity
look — needs three things this tutorial doesn't otherwise need:

1. **Depth sorting.** When a wall stands "in front" of a player
   in screen space, you have to draw the player first, then the
   wall, then any UI overlay. The sort key is non-trivial: `y +
height + z` or some tile-corner heuristic. Get it wrong and
   sprites flicker behind walls.
2. **Sprite stacking.** Tile sprites have to be drawn in
   multi-layer order (floor → walls → entities → effects) with
   per-layer alpha. Asset authoring overhead.
3. **An asset pipeline.** Isometric tiles need pre-rendered
   sprites at specific angles; you can't fake them with
   font glyphs. The reader hits a "go source 64×32 PNGs" detour
   that has nothing to do with actjs.

Top-down tile-based rendering needs **none of that**. Each tile
is a flat rectangle in a grid; draw order is "loop over rows,
loop over columns." Entities (chapter 05+) draw on top of their
tile, no depth math. Sprites can be Unicode glyphs or simple
PNGs swapped in later. The reader's attention stays on the
backend.

If you want isometric later, bonus chapter X3 swaps the renderer
for Phaser or PixiJS — both have isometric tile-map plugins. The
server code doesn't move.

## Install `@fastify/static`

We're going to serve a `public/` directory from the same Fastify
instance that runs the actjs server. The cleanest way is the
official static-file plugin:

```bash
pnpm add @fastify/static
```

## Wire it into the server

Open `src/server.ts` and add the plugin registration after
`buildApp` returns:

```ts
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import { Runtime } from '@jplevyak/actjs/runtime';
import { buildApp } from '@jplevyak/actjs/server';
import { MemoryStorageDriver } from '@jplevyak/actjs/storage';
import { asClassName, asVersion } from '@jplevyak/actjs/types';

import { Room } from './room.js';

const driver = new MemoryStorageDriver();
await driver.init();

const runtime = new Runtime(driver);
runtime.register({
  name: asClassName('Room'),
  version: asVersion('1.0.0'),
  ctor: Room,
});

const app = await buildApp({ driver, runtime });

// Serve the browser bundle from `public/`. The plugin claims the
// `/` prefix, so `/main.js` and `/style.css` resolve to
// `public/main.js` and `public/style.css`. The actjs routes all
// live under `/v1/...` so there's no collision.
const here = dirname(fileURLToPath(import.meta.url));
await app.register(fastifyStatic, {
  root: join(here, '..', 'public'),
  prefix: '/',
});

const port = Number(process.env['PORT'] ?? 3000);
await app.listen({ port, host: '0.0.0.0' });

console.log(`dungeon: listening on http://localhost:${port}`);
console.log(`dungeon: open http://localhost:${port} in a browser`);

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

Three new lines of substance — the import, the plugin
registration, and the `console.log` pointing at the browser URL.
Everything else is unchanged from chapter 03.

> **Why register the static plugin after `buildApp`?** Fastify
> plugin order matters: routes registered later override earlier
> ones at the same prefix. By registering actjs's routes first
> (inside `buildApp`) and the static plugin last, any path that
> matches both — e.g. `/v1/health` — goes to actjs. There aren't
> any collisions in practice, but the ordering is the safe
> default.

## Create the `public/` directory

```bash
mkdir public
```

We'll add two files: `index.html` and `main.js`.

## `public/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Dungeon</title>
    <style>
      body {
        background: #1a1a1a;
        color: #ddd;
        font-family: system-ui, sans-serif;
        margin: 0;
        padding: 1rem;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
      }
      .meta {
        display: flex;
        gap: 1rem;
        font-size: 0.9rem;
      }
      .meta code {
        background: #333;
        padding: 0 0.4rem;
        border-radius: 3px;
      }
      canvas {
        background: #000;
        border: 1px solid #333;
      }
      a {
        color: #6fa;
      }
    </style>
  </head>
  <body>
    <div class="meta">
      <span>Room: <code id="roomId">…</code></span>
      <a href="?">fresh dungeon</a>
    </div>
    <canvas id="dungeon"></canvas>
    <script type="module" src="/main.js"></script>
  </body>
</html>
```

A header strip with the room id (so you can copy-paste it to a
friend or back into a `curl` command) and a "fresh dungeon" link
that clears the URL. The `<canvas>` is sized dynamically by the
renderer; we don't hard-code its dimensions here.

## `public/main.js`

```js
// One pixel-tile size. 24 is comfortable at 20×20 → 480×480 canvas.
const TILE = 24;

// Per-tile-character render hints. `color` is the rectangle fill;
// `glyph` is an optional Unicode character drawn over it.
const TILE_STYLES = {
  '#': { color: '#3a3a3a', glyph: '' }, // wall
  '.': { color: '#161616', glyph: '' }, // floor
  '+': { color: '#a87a25', glyph: '+' }, // door
};
// Anything not in TILE_STYLES gets drawn as the raw character on
// a magenta background — visible bug indicator, harmless if it
// never fires.
const UNKNOWN_STYLE = { color: '#ff00ff', glyph: '?' };

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

async function mintRoom() {
  const { id } = await rpc('/v1/actors/Room');
  return id;
}

async function readRoom(id) {
  const { result } = await rpc(`/v1/actors/Room/${id}/read`);
  return result;
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
      const ch = row[x];
      const style = TILE_STYLES[ch] ?? UNKNOWN_STYLE;
      ctx.fillStyle = style.color;
      ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
      if (style.glyph) {
        ctx.fillStyle = '#fff';
        ctx.fillText(style.glyph, x * TILE + TILE / 2, y * TILE + TILE / 2);
      }
    }
  }
}

async function main() {
  // ?id=<actorId> → render an existing room. Empty query → mint.
  const params = new URLSearchParams(location.search);
  let id = params.get('id');
  if (!id) {
    id = await mintRoom();
    // Update the URL without reloading so a refresh stays on the
    // same room and the URL is sharable.
    history.replaceState(null, '', `?id=${id}`);
  }
  document.getElementById('roomId').textContent = id;

  const room = await readRoom(id);
  render(document.getElementById('dungeon'), room);
}

main().catch((err) => {
  document.body.innerHTML = `<pre style="color:#f55;padding:1rem">${err.stack}</pre>`;
});
```

Roughly 80 lines, no dependencies, no build step.

Five things to call out:

- **`TILE_STYLES`** is the entire glyph dictionary. We're using
  color-coded rectangles as the primary visual; glyphs only
  appear for the door (so it stands out against the wall
  color). When we add a player in chapter 07 we'll grow the map
  with one more entry. When we add merchants and rats later,
  one entry each. There's no other extension point — the
  renderer doesn't care what the symbols _mean_.
- **`UNKNOWN_STYLE`** is your debug net. If you ever push a new
  tile character to the server and forget to teach the
  renderer about it, you'll see magenta squares with a `?`
  instead of mysteriously-missing tiles. Cheap to add, saves
  ten minutes of "why is the room empty?" debugging later.
- **`rpc(path, body)`** is a one-screen helper that does
  `POST + JSON + structured error`. Both `mintRoom` and
  `readRoom` use it. The same helper will be enough for every
  remaining REST call in the tutorial — we'll outgrow it only
  in chapter 06 when WebSocket subscriptions arrive.
- **URL-as-room-id.** First load mints a fresh actor and
  `history.replaceState` parks the id in the query string. Any
  subsequent reload (browser refresh, share-the-URL, hit
  Enter in the address bar) loads the same room. The "fresh
  dungeon" link in the header strips the query string to mint
  another.
- **Catch + dump-to-page.** If anything throws — a bad
  response, a typo, the server being down — the page shows
  the error stack instead of failing silently. Useful while
  iterating; less useful in production, but production is
  chapter 18.

## Run it

```bash
pnpm dev
```

Open `http://localhost:3000/` in a browser. You should see your
dungeon: dark walls, near-black floor, an orange `+` door at
the top-center.

The URL in the address bar will look like:

```
http://localhost:3000/?id=019e4d5e-1111-7222-9333-444455556666
```

Try it three ways:

1. **Reload.** The same room comes back — the actor id in the
   URL points at the same actor, whose snapshot has been
   persisted by the runtime.
2. **Click "fresh dungeon"** in the header. The URL clears,
   a new actor gets minted, you see a different layout.
3. **Open the URL in a second tab.** Same room, same layout
   — even though the second tab made its own `read` call, it
   hit the same actor.

The bookmarkable URLs aren't anything we built into actjs;
they fall out of the fact that actor ids are stable
identifiers. Anything the runtime addresses by id is implicitly
URL-addressable.

## Sanity check: what HTTP did the browser actually do

Open your browser's Network panel and reload the page. You'll
see four requests:

| Path                       | Method | Verb-equivalent for an actjs operator |
| -------------------------- | ------ | ------------------------------------- |
| `/`                        | GET    | Served `index.html` from `public/`.   |
| `/main.js`                 | GET    | Served `main.js` from `public/`.      |
| `/v1/actors/Room`          | POST   | Minted an actor id (first visit).     |
| `/v1/actors/Room/.../read` | POST   | Materialized the room + ran `read`.   |

The third one only fires on first visit (no `?id=` in the URL);
subsequent visits skip straight to the fourth. The OpenAPI
document `GET /openapi.json` documents both of these routes —
the wire interface to your renderer is just the two endpoints
that `runtime.register(Room)` lit up in chapter 02.

## Commit + tag

```bash
git add .
git commit -m "ch04: browser renderer + static-file plugin"
git tag ch04-done
```

## Recap

The chapter shipped four artifacts and one architectural choice:

| Artifact                       | Lines | Purpose                                         |
| ------------------------------ | ----- | ----------------------------------------------- |
| `@fastify/static` registration | 4     | Serve `public/` alongside the actjs routes.     |
| `public/index.html`            | ~30   | Page scaffold, header strip, `<canvas>`.        |
| `public/main.js`               | ~60   | Mint-or-load + render.                          |
| URL `?id=<actorId>` convention | (n/a) | Bookmarkable per-room URLs without server work. |

Choice: **color-coded rectangles with optional Unicode glyph
overlays**, growing as features arrive (player ch 07, merchant
ch 10, rat ch 11). Not Phaser, not PixiJS, not isometric — those
all belong in bonus chapter X3.

What was missing from this chapter that you might expect:

- **No animation.** The dungeon is static; we just draw it
  once. Animation arrives in chapter 05 (per-tick movement)
  and chapter 06 (live updates via WS subscriptions).
- **No input handling.** Click-to-move shows up in chapter 05.
- **No camera.** The whole 20×20 grid fits in the viewport,
  so we don't need scrolling, zoom, or culling. Multi-room
  scrolling shows up in chapter 09.

Most importantly: **the server didn't move.** Every actjs
primitive we touched was already shipped by chapter 02. The
renderer is a pure consumer of the REST surface.

## What's next

**Chapter 05 — Click-to-move + server pathfinding** is where the
dungeon stops being a static painting. We'll add a player entity
(in room state, not a separate actor yet — that's chapter 07),
A\* pathfinding inside the room's grid, and an `actjs.scheduleAt`
tick loop that advances the player one tile every 200 ms. The
renderer learns to draw moving entities on top of tiles. You'll
spend chapter 06 dropping the polling and switching to a WS
subscription so two browser tabs see each other move.

---

## Troubleshooting

**Browser shows the error stack, "Cannot read property of
undefined"**

Most likely cause: a tile character in `state.tiles` isn't in
`TILE_STYLES`. Look at the magenta squares (`UNKNOWN_STYLE`) —
they tell you exactly which character is unaccounted for. Add
it to `TILE_STYLES` and reload.

**Page shows `404` on `/main.js`**

The static plugin's `root` doesn't point at the right directory,
or `public/main.js` doesn't exist. The `here` constant in
`server.ts` is the directory of the compiled `server.js`; the
plugin walks up one level (`..`) to find `public/`. If your
project layout differs, adjust accordingly.

**Page is blank, no errors**

Open the browser's Network panel and see what
`/v1/actors/Room/<id>/read` returned. If it's 404, the actor id
in the URL is stale (perhaps from a server restart that lost
state) — clear the query string and reload to mint a fresh
room. If it's 500, check the server logs.

**Emoji glyphs render as boxes**

The chapter only uses plain ASCII (`+`) for the door, so this
shouldn't happen yet. When future chapters add emoji glyphs
(🧙, 🗡️, 🐀), font fallback chains differ across OSes — Linux
without a color-emoji font shows boxes. Either install
`noto-fonts-emoji` (Linux) or replace the emoji with another
ASCII character in your local `TILE_STYLES`.

**The canvas is tiny or huge**

`TILE = 24` gives a 480×480 canvas for a 20×20 room. Smaller
values (16, 12) produce a denser look; larger (32, 48) produce
a chunky retro-feel. Whatever you pick should be at least 12
to keep the door glyph legible.
