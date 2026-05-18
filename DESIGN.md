# actjs — Design

This document describes the internals of actjs: what the moving parts are,
why they exist, and how a request flows through the system. It is meant for
people modifying the framework, not for users of it. For usage, see
[`README.md`](./README.md).

## Goals & non-goals

**Goals.**

- Treat a single HTTP request as a serializable database transaction over a
  graph of _actors_ (long-lived JSON objects with methods).
- Let actors hold references to other actors, and load referents lazily on
  property access.
- Allow user code (both ad-hoc snippets and actor class definitions) to be
  shipped to the running server and executed there.
- Use Redis as the only durable store, with WATCH/MULTI/EXEC providing
  optimistic concurrency control.

**Non-goals.**

- Sandboxing or isolation of user code. `/run` and `/upload` execute
  arbitrary JavaScript in the server process.
- Multi-node clustering, replication, sharding, or migration.
- Long-lived actor instances. Each transaction loads its own copies; there
  is no in-memory actor pool across requests.
- A persistent schema. Classes are blobs of source in Redis, looked up by
  name on demand.

## Components

```
                  ┌────────────────────────────┐
                  │      main.js (entry)       │
                  └─────────────┬──────────────┘
                                │ ESM import
                  ┌─────────────▼──────────────┐
                  │       top.js (server)      │
                  │   ─ Express 5              │
                  │   ─ multer (uploads)       │
                  │   ─ per-request Redis      │
                  │     connection             │
                  └──────┬───────────────┬─────┘
                         │               │
                  ┌──────▼─────┐   ┌─────▼──────┐
                  │  /run      │   │  /upload   │
                  │  builds    │   │  stores    │
                  │  AsyncFn   │   │  files in  │
                  │  + GAct    │   │  Redis by  │
                  │            │   │  original  │
                  │            │   │  name      │
                  └─────┬──────┘   └─────┬──────┘
                        │                │
                  ┌─────▼────────────────▼─────┐
                  │      gact.js (engine)      │
                  │   GAct, Actor, Aggregate,  │
                  │   Replica, class loader,   │
                  │   (de)serialization        │
                  └────────────────┬───────────┘
                                   │
                            ┌──────▼──────┐
                            │    Redis    │
                            └─────────────┘
```

| File       | Role                                                        |
| ---------- | ----------------------------------------------------------- |
| `main.js`  | One-line ESM entry. Imports `top.js` to start the listener. |
| `top.js`   | HTTP layer. Routes, body parsing, multer, error mapping.    |
| `gact.js`  | Transaction & actor engine. Pure ESM module, no Express.    |
| `error.js` | `StatusError` — `Error` subclass carrying an HTTP status.   |

## The transaction (`GAct`)

A `GAct` is created per request by `/run` and lives only for that request:

```js
const gact = new GAct(tid, redisClient);
// user code runs: await f(gact)
await gact.commit();
```

Fields:

| Field                         | Meaning                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| `tid`                         | Monotonic per-process transaction id (informational only).       |
| `redis`                       | Connected Redis client (one per HTTP request; injected).         |
| `actors`                      | `Record<id, Actor>` — every actor touched in this transaction.   |
| `actors_json`                 | `Record<id, string>` — JSON each loaded actor _started_ as.      |
| `max_retries`                 | How many times `/run` will rerun on commit conflict (default 5). |
| `aborted`                     | If `abort()` was called, `commit()` is a no-op success.          |
| `Actor`,`Aggregate`,`Replica` | The three base classes, exposed to user code.                    |

The transaction id is not used for locking — Redis WATCH/MULTI is the only
concurrency mechanism. The `tid` exists for logging and future tracing.

## Actor identity & storage

Each actor has an `actor_id` (`crypto.randomUUID()` if not supplied). The
actor is stored in Redis under the key equal to its `actor_id`, as
`SET <actor_id> <JSON>`.

The on-disk JSON of an actor is a flat object of its own enumerable
properties, plus a synthesized `actor_class` field that names its class:

```json
{
  "actor_class": "Beta",
  "b": "b"
}
```

Cross-actor references are stored as objects of the form `{ "actor_id": "<id>" }`.
A parent that holds two references will serialize as e.g.:

```json
{
  "actor_class": "Foo",
  "left": { "actor_id": "uuid-a" },
  "right": { "actor_id": "uuid-b" }
}
```

References are stored at the top level keyed by the parent's property names
(`left`, `right`). When the parent is loaded, those property slots become
lazy-load getters (see below) and the raw id pairs move into a sidecar
`actor_ids` map for serialization.

There is no per-class index, no version field, no envelope. The class name
_is_ the schema pointer.

## Class loading

When `GAct.load(id)` reads an actor JSON whose `actor_class` is unknown to
this `GAct` instance, it calls `loadClass(name)`:

1. `GET <name>.js` from Redis. (Uploads via `/upload` populate that key.)
2. Wrap the source as the body of `new AsyncFunction('gact', source)`.
3. `await f(gact)` — the source is expected to `return SomeClass`.
4. Install the returned class as `gact[name]` so later `loadClass` calls in
   the same transaction skip the round-trip.

The user file is a function body, not a module. That is why example classes
end with `return Beta;`:

```js
// Beta.js  — this is wrapped in `async function(gact) { ... }`
class Beta extends gact.Actor { ... }
return Beta;
```

The class cache is per `GAct`, so it warms on every transaction. A future
refinement could cache compiled classes across transactions keyed by source
hash; the TODO comment at the top of `gact.js` notes this.

## Loading: prototype swap + lazy refs

`GAct.load(id)` resurrects an actor instance from JSON without invoking its
constructor:

1. `WATCH id` (Redis side — see "Concurrency" below).
2. `GET id` → JSON. Return `null` if absent or missing `actor_class`.
3. `JSON.parse` → plain object `a`.
4. Look up (or load) `gact[a.actor_class]`.
5. `Object.setPrototypeOf(a, gact[a.actor_class].prototype)` — `a` now
   _is_ an instance of that class without the constructor running.
6. Attach `a.actor_id`, `a.gact`, and delete `actor_class` (it's
   regenerated on save from `a.constructor.name`).
7. Walk the object via `fixupFromLoad`, replacing every nested
   `{ actor_id }` placeholder with a lazy-load accessor.
8. Cache `a` in `gact.actors[id]` and freeze the original JSON in
   `gact.actors_json[id]` so the save step can detect changes.

The lazy-load accessor (`setActorPropertyById`) replaces the property with
a getter/setter pair:

- **First read** returns `gact.load(id)`, i.e. a `Promise<Actor>`. When that
  promise resolves, its `.then` callback rewrites the property to be a
  plain `{ value }` slot pointing at the resolved actor. So `await c.d`
  works the first time; later reads of `c.d` after the `await` give the
  actor synchronously.
- **Writes** also replace the slot with a plain value, so assigning
  `c.d = newActor` discards the lazy-load.

The id-to-property mapping is mirrored in `a.actor_ids`, an own property on
the actor. This is a serialization aid: at save time, `fixupForSave` sees
that any property defined via getter (no `value` in its descriptor) has not
yet been resolved, and reads the underlying id from `actor_ids` instead of
firing the getter (which would do I/O during serialization).

## Saving: change detection + MULTI

`GAct.save()` walks `gact.actors`, serializes each actor with `fixupForSave`,
and stages a `SET id json` in a Redis MULTI block — but only for actors
whose serialized JSON differs from `actors_json[id]` (their value at load
time). New actors created during the transaction have no entry in
`actors_json` and so are always written.

`fixupForSave` mirrors `fixupFromLoad`:

- Skip own properties defined only as getter/setter (unresolved refs).
- Skip `Promise` values (in-flight lazy loads).
- Skip the `gact` back-reference (`instanceof GAct`).
- Skip the `save_replica` sentinel.
- Convert the `actor_ids` sidecar map back to inline `{ actor_id }`
  references at the original property names.
- Convert resolved `Actor` values to `{ actor_id }` references rather than
  inlining them (each actor is independently persisted under its own key).
- Recurse for everything else.

`save()` returns:

- `true` if there was nothing to write (it issues `UNWATCH` so we don't leak
  watches into a future request on a pooled client).
- `true` if `MULTI/EXEC` returned an array (commands applied atomically and
  no watched key was touched concurrently).
- `false` if `EXEC` returned `null` (a watched key changed — the entire
  transaction is invalid).

`commit()` is a thin wrapper that short-circuits to success if `abort()`
was called.

## Concurrency control

actjs implements _optimistic, snapshot-comparable_ serializability through
Redis:

1. Every `load(id)` issues `WATCH id` before reading.
2. The full set of writes is staged in a single `MULTI` block and submitted
   in one `EXEC`.
3. Redis aborts the EXEC (returns `null`) if any watched key was written by
   another client between its WATCH and the EXEC.
4. On null EXEC, `/run` discards the `GAct`, increments an attempt counter,
   and re-runs the user code against a fresh `GAct` (same Redis client;
   EXEC clears watches on failure, so reuse is safe).
5. After `max_retries` (default 5), `/run` returns HTTP 409.

Notes and limits:

- Only keys explicitly _read_ via `load` are watched. Snippets that
  blind-write via `gact.write(id, ...)` do not participate.
- Watching only happens on first load; the actor cache in `gact.actors`
  short-circuits subsequent calls.
- Redis WATCH is per-connection, which is why `/run` holds one Redis client
  for the lifetime of the request (including retries) rather than for the
  lifetime of a single attempt.

## Executing user code

The `/run` and class-loading paths both use:

```js
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const f = new AsyncFunction('gact', source);
const value = await f(gact);
```

This replaces the original Babel-`transform` + `eval` pipeline. Modern V8
parses every ES feature actjs needs (`let`/`const`, classes, `await`, top-
level `return`, optional chaining, etc.) directly, and `AsyncFunction`
gives us a callable function whose body is the supplied source.

Properties of this choice:

- `gact` is the function's single parameter — user code references it
  exactly the way the example snippets do.
- Top-level `await` inside the snippet works because the function is async.
- `return value;` from the snippet becomes the resolved value of the
  outer `await`.
- _No_ sandbox. Variables declared in the snippet live in the function
  scope and disappear when it returns, but global state (the Node process,
  `globalThis`, modules already loaded) is fully reachable from user code.
  See "Security" below.

Syntax errors in `new AsyncFunction(...)` are surfaced as a 400 by the
`/run` handler.

## Replica vs Actor vs Aggregate

`Aggregate` is currently identical to `Actor`. It exists as a marker for
future divergence (e.g. event-sourced aggregates with append-only
projections), and so that the framework's public surface already has the
three-way split.

`Replica` differs from `Actor` in exactly one way: the constructor sets
`this.save_replica = true`, and `save()` skips any `Replica` whose
`save_replica` is falsy. The `save_replica` field itself is filtered out
of the serialized form, so it is purely a per-transaction-in-memory flag.

The result is a "read-mostly" actor class: a `Replica` can be loaded,
mutated, and used like any other actor within a transaction, but the
mutations are not written back unless the snippet explicitly opts in by
setting `save_replica = true` again (or by re-creating the replica, which
resets it to true).

The demo (`demo3_read`) exercises this: it loads a `Replica`, mutates a
field, and returns both values. Re-running the snippet shows the on-disk
state unchanged.

## HTTP layer (`top.js`)

`top.js` is deliberately thin:

- A single Express 5 app with three routes (`GET /`, `POST /run`,
  `POST /upload`) and one error handler.
- Body parsers (`express.json`, `express.text({ type: '*/*' })`) are scoped
  to `/run` only. They are _not_ registered globally, because a wildcard
  text parser would consume `multipart/form-data` before multer could read
  the stream.
- `/upload` uses `multer@2.x` with `memoryStorage()` and accepts any field
  name via `.any()`. Each file is written to Redis by its `originalname`.
- `withRedisClient(fn)` opens a fresh Redis connection per request, calls
  `fn(client)`, and `quit()`s the connection in a `finally`. The retry
  loop reuses that one connection across attempts.
- The error middleware maps `StatusError` to its `status` field and any
  other thrown error to a 500 with `{ name, message }`.
- Express 5's native promise propagation means handler `async` functions
  can simply `throw` — there is no `try { ... } catch (e) { next(e) }`
  boilerplate.

## Failure modes

| Failure                               | Where caught             | HTTP code                 | Notes                             |
| ------------------------------------- | ------------------------ | ------------------------- | --------------------------------- |
| Syntax error in `/run` snippet        | `new AsyncFunction(...)` | 400                       |                                   |
| Snippet throws                        | `await f(gact)` catch    | 400                       | `StatusError` rethrown as-is.     |
| Class source missing                  | `loadClass`              | 404                       |                                   |
| Class source compile error            | `loadClass`              | 400                       |                                   |
| `actor_class` not loadable            | `load`                   | 400                       |                                   |
| Commit conflict (watched key changed) | retry loop in `/run`     | 409 (after `max_retries`) | Earlier conflicts retry silently. |
| Multer / form parse error             | error middleware         | 500                       |                                   |
| Redis read/write error                | `read`/`write`           | 500                       | Surfaces as `StatusError`.        |

## Security

actjs runs untrusted JavaScript directly inside the Node process. There is
no isolation:

- `/run` snippets and uploaded class sources can `require`/`import`
  anything available to the host process.
- File I/O, network I/O, process spawn — all reachable.
- Multipart uploads accept arbitrary `originalname`, which becomes a Redis
  key. A hostile uploader can therefore overwrite any class source
  (including legitimate uploaded ones) by colliding on name.

Treat actjs as a single-tenant sketch behind a trust boundary. If you need
to expose it more broadly, the obvious next steps are: a real sandbox for
user code (`vm.Context` is not sufficient — process isolation or
`isolated-vm`), an upload allow-list for class names, and authentication
on both endpoints.

## Open / deferred design questions

These are explicitly _not_ solved:

- **Cross-transaction class cache.** Today every `GAct` reloads class
  source on first use. A digest-keyed cache (`/class_sha256/<Name>`) is
  sketched as a TODO at the top of `gact.js`.
- **Garbage collection.** Actors with no incoming reference are never
  reaped — Redis keeps them indefinitely.
- **Schema evolution.** Renaming a class breaks every actor with the old
  `actor_class`. There is no migration path.
- **Aggregate semantics.** `Aggregate` exists as a stub. The intended
  difference from `Actor` (e.g. event sourcing, projections) is undefined.
- **Cycles.** `fixupForSave` does not detect object cycles within a single
  actor's own data. Cross-actor cycles are fine (each side just holds an
  id), but a self-referential plain object will recurse forever.
- **Numeric / Date / Map / Set fields.** Only what `JSON.stringify` can
  round-trip is supported. There is no custom serialization hook.
