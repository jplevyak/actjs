# Chapter 01 — Setup

> **Chapter goal:** scaffold a Node project, install actjs, wire a
> minimal server, run it, hit `/v1/health` from `curl`, see a `200`.
> No actors yet — those start in chapter 02.
>
> **Time budget:** ~30 minutes.
>
> **End-of-chapter tag:** `ch01-done`.

---

We're going to spend most of this tutorial inside actor code,
designing rooms and merchants and parties. Before any of that we
need a server we can talk to. This chapter sets up the smallest
possible actjs server: a `Runtime`, a storage driver, a Fastify
app, and a `dev` script. That's four moving parts, and once they're
in place the rest of the tutorial just adds actors to the runtime.

By the end of this chapter you will:

- Have a Node + TypeScript project that builds and runs.
- Have an actjs `Runtime` instantiated against the in-memory
  storage driver — no Docker, no Postgres, no Valkey.
- Have an HTTP server responding to `GET /v1/health` with `200`.
- Understand which actjs primitive does what so the next chapter's
  actor code feels like an extension, not a new concept.

## Prerequisites

- **Node.js 20 or newer.** Run `node --version` to check.
- **A package manager.** This tutorial uses `pnpm`; `npm` or
  `yarn` work identically, just translate the commands.
- **Nothing else.** No Docker in the main spine until chapter 18
  (the production checklist). The in-memory driver makes early
  chapters friction-free.

## Project layout

We're going to create exactly four files. The shape is:

```
dungeon/
├── package.json
├── tsconfig.json
└── src/
    └── server.ts
```

Make the directory and step in:

```bash
mkdir dungeon && cd dungeon
git init
```

> **Why `git init` already?** The tutorial uses
> `git tag ch01-done` at the end of every chapter so you can jump
> ahead with `git checkout ch07-done` later. Starting the git
> history at chapter 01 keeps the tag set linear.

## `package.json`

```bash
pnpm init
```

That writes a default `package.json`. Edit it to look like this:

```json
{
  "name": "dungeon",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -b",
    "start": "node dist/server.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "actjs": "^0.3.0",
    "fastify": "^5.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.6.0"
  }
}
```

A few specifics worth noting:

- **`"type": "module"`** — actjs ships ESM-only. Node 20 handles
  this natively; the `import` statements in `src/server.ts`
  resolve without a build step at dev time.
- **`tsx watch`** — runs TypeScript directly without precompiling,
  and restarts the server when files change. This is our entire
  dev loop. No webpack, no esbuild config.
- **`actjs` + `fastify` as dependencies** — actjs uses Fastify as
  its HTTP layer; you'll see why in a few lines. The version
  range pins to whatever shipped with the tutorial.

Install:

```bash
pnpm install
```

## `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "experimentalDecorators": false
  },
  "include": ["src/**/*"]
}
```

The bits that matter:

- **`module: NodeNext`, `moduleResolution: NodeNext`** — actjs
  imports are package-relative (`actjs/runtime`,
  `actjs/storage`). NodeNext resolution honors the
  `package.json` exports map; older resolution modes silently
  fall back to legacy paths or fail.
- **`experimentalDecorators: false`** — actjs uses TC39
  stage-3 decorators (the ones built into modern TypeScript)
  for `@handler`, not the legacy `experimentalDecorators`
  flag. Make sure this is `false` or omitted; setting it to
  `true` will break chapter 02.
- **`strict: true`** — non-negotiable for actjs because the
  domain types (`ActorId`, `ClassName`, `Version`) lean on
  strict null checks and branded types to keep "a string that
  might be an actor id" out of your code.

## `src/server.ts`

This is the whole server. Create `src/server.ts` and paste:

```ts
import { Runtime } from 'actjs/runtime';
import { buildApp } from 'actjs/server';
import { MemoryStorageDriver } from 'actjs/storage';

// 1) The storage driver owns durable state. The memory driver
//    is enough through chapter 17; chapter 18 swaps in the
//    Postgres-backed driver for production.
const driver = new MemoryStorageDriver();
await driver.init();

// 2) The Runtime owns the actor lifecycle: register class
//    definitions, route calls to live actor hosts, drive the
//    reminder dispatcher. It needs the driver and nothing else
//    for the basic shape.
const runtime = new Runtime(driver);

// 3) buildApp wires the Fastify HTTP layer: REST routes for
//    every registered actor class, a JSON-RPC WebSocket
//    endpoint, the X-Actjs-Manifest pin hook, the Idempotency-Key
//    hook, RFC 7807 error mapping, and OpenAPI 3.1 at
//    /openapi.json. We don't have any actor classes registered
//    yet, so the only meaningful route is /v1/health.
const app = await buildApp({ driver, runtime });

// 4) Listen. 3000 is the actjs default; override with PORT.
const port = Number(process.env['PORT'] ?? 3000);
await app.listen({ port, host: '0.0.0.0' });

console.log(`dungeon: listening on http://localhost:${port}`);
console.log(`dungeon: try \`curl http://localhost:${port}/v1/health\``);

// 5) Graceful shutdown so Ctrl-C doesn't leave the runtime in
//    a half-cleared state. drain() lets every active actor finish
//    its current mailbox turn; shutdown() releases the driver's
//    connections (a no-op for the memory driver, a real close
//    for Postgres).
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

Five numbered blocks; if you only remember four things from this
chapter, remember the first four:

1. **`MemoryStorageDriver`** — durable state lives here. Snapshots,
   events, reminders, audit log. The memory driver keeps them in
   a `Map`; `ValkeyPgStorageDriver` (ch 18) keeps them in
   Postgres + Valkey. Every other piece of actjs reads and
   writes through the driver — no exceptions, no bypasses.
2. **`Runtime`** — registers actor classes and routes calls to
   actor hosts. You'll spend most of the tutorial talking to
   the runtime: `runtime.register(...)`, `runtime.call(...)`,
   `runtime.tombstone(...)`.
3. **`buildApp`** — builds the Fastify HTTP server with all of
   actjs's routes pre-wired. There's no "create an HTTP route
   per actor method" step ever in this tutorial — registering
   an actor class automatically exposes its handlers over REST
   and WebSocket.
4. **`app.listen`** — boring Fastify. The exact same interface
   you'd use with vanilla Fastify; we just got the rest of the
   server for free.

The fifth block (graceful shutdown) isn't actjs-specific but is
worth doing once now so we stop worrying about it.

## Run it

```bash
pnpm dev
```

You should see:

```
dungeon: listening on http://localhost:3000
dungeon: try `curl http://localhost:3000/v1/health`
```

Open a second terminal and:

```bash
curl http://localhost:3000/v1/health
```

You should get something like:

```json
{ "status": "ok", "uptimeMs": 3142 }
```

`uptimeMs` is the milliseconds since the server booted; it'll be a
different number on every request. If you see a different shape or
a non-200 status, jump down to **Troubleshooting** at the bottom
of this chapter.

## What you actually got

Even though we didn't register any actors yet, the server is
already doing a surprising amount of work. Try a few of these:

```bash
# OpenAPI document — every actjs server exposes this.
curl http://localhost:3000/openapi.json | jq '.paths | keys'
# → [ "/v1/admin/manifests/in-use", "/v1/classes", ..., "/v1/health" ]

# RFC 7807 error mapping on an unknown route.
curl -i http://localhost:3000/v1/nonsense
# → 404 application/problem+json with a structured body.

# Class listing route (no classes registered yet, returns a
# NotImplemented problem detail; chapter 02 will populate it).
curl -i http://localhost:3000/v1/classes
```

Those routes appeared because `buildApp` registered them. You
didn't write any of that.

## Commit + tag

```bash
git add .
git commit -m "ch01: scaffold actjs server with memory driver"
git tag ch01-done
```

That's the chapter. The repo is in the `ch01-done` state. If
you skip ahead to chapter 07, you'd `git checkout ch07-done` and
start there; if you want to diff what changed in chapter 03,
you'd `git diff ch02-done ch03-done`.

## Recap

We touched four primitives — each will reappear constantly:

| Primitive             | What it does                                    | When you'll touch it next                                                    |
| --------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `MemoryStorageDriver` | Holds all durable state.                        | Every chapter, indirectly. Direct contact again in ch 18 when we swap to PG. |
| `Runtime`             | Registers actor classes, routes calls.          | Chapter 02 (`runtime.register(Room)`), then continuously.                    |
| `buildApp`            | Builds the Fastify HTTP server with all routes. | Once more in chapter 11 when we add auth (`buildApp({ ..., auth })`).        |
| `app.listen`          | Starts the HTTP listener.                       | Never again — set it once, forget it.                                        |

The memory-driver + runtime + app trio is the shape of every
actjs server, from this tutorial to a production deployment. The
PG swap in chapter 18 is literally one line:
`new ValkeyPgStorageDriver({...})` instead of
`new MemoryStorageDriver()`. Everything else stays the same.

## What's next

In **chapter 02 — The Room actor**, we'll write our first actor
class. The pattern is:

1. Subclass `Actor<S>` with a state shape.
2. Decorate methods with `@handler`.
3. Register the class with the runtime.
4. The REST and WS routes for that class light up automatically.

By the end of chapter 02 you'll be `curl POST`'ing to a `Room`
actor and reading its state back. The full procgen + rendering
arrives in chapters 03 and 04.

---

## Troubleshooting

**`Cannot find module 'actjs/server'`**

You probably have an older `actjs` installed where `./server`
isn't in the exports map. Run `pnpm install actjs@latest` and
try again. (This export was added in the 8.2 release — the
server entry was always there, just not surfaced.)

**`SyntaxError: Cannot use import statement outside a module`**

The `"type": "module"` field in `package.json` is missing. Add
it and re-run `pnpm dev`.

**TypeScript errors about decorators**

If you see `experimentalDecorators` errors here, you set the
flag to `true`. Set it back to `false` (or just delete the
line). actjs uses the modern TC39 decorators that ship with
TypeScript 5 by default.

**Server starts, but `curl /v1/health` times out**

Check the `listen` host. The example uses `0.0.0.0`; if you
bound to `127.0.0.1` and you're hitting it from a Docker
container or a remote host, it won't reach. Stick to
`0.0.0.0` for local development.

**`EADDRINUSE: address already in use :::3000`**

Something else is on port 3000. Either kill it or run
`PORT=3001 pnpm dev`.
