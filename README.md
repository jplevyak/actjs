# actjs

A small JavaScript actor framework sketch. Actors live in Redis; each HTTP
request is an optimistic-concurrency transaction that loads, mutates, and
commits actors as a unit. Class source can be uploaded at runtime and is loaded
on demand the first time an actor of that class is read.

This is a sketch — not production-grade. It runs arbitrary user JavaScript
server-side and has no authentication.

## Concepts

- **`GAct`** — a transaction. Wraps one Redis connection, an actor cache, and
  a snapshot of each actor's JSON at load time.
- **`Actor`** — base class. Persists by JSON-serializing own properties.
- **`Aggregate`** — `Actor` subclass (currently identical to `Actor`).
- **`Replica`** — `Actor` subclass whose state is only persisted when
  `save_replica` is true. Useful for in-memory views that you don't want to
  write back on every transaction.
- **Lazy actor references** — when an actor holds another actor in a property
  it is serialized as `{ actor_id }`. On load, that property becomes a getter
  that returns a `Promise` resolving to the referenced actor; `await c.d`
  triggers the load.
- **Optimistic concurrency** — every `gact.load(id)` issues `WATCH id`. The
  final `MULTI/EXEC` on commit fails (and the transaction retries, up to
  `max_retries`) if any watched key was modified concurrently.

## Requirements

- Node.js ≥ 20
- Valkey (or Redis) running locally, or reachable via `REDIS_URL`
- `curl` for the demo; `jq` optional for pretty JSON output

## Install & run

```bash
npm ci
npm run build
npm start                # listens on PORT (default 3000)
```

Or, in one step against Valkey + Postgres in containers:

```bash
docker compose up --build
```

For active development:

```bash
npm run dev              # tsx watch on src/main.ts
```

Scripts:

| Script                  | What it does                                   |
| ----------------------- | ---------------------------------------------- |
| `npm run build`         | `tsc -b` → `dist/`                             |
| `npm run dev`           | `tsx watch src/main.ts` for hot reload         |
| `npm start`             | `node dist/main.js` (requires a prior `build`) |
| `npm run typecheck`     | `tsc --noEmit`                                 |
| `npm run lint`          | ESLint over `src/`, `tests/`, configs          |
| `npm run format`        | Prettier write                                 |
| `npm test`              | Vitest run                                     |
| `npm run test:coverage` | Vitest + v8 coverage with thresholds           |
| `npm run demo`          | `./demo.bash` against a running server         |

Environment variables:

| Var         | Default                  | Purpose                       |
| ----------- | ------------------------ | ----------------------------- |
| `PORT`      | `3000`                   | HTTP listen port              |
| `REDIS_URL` | (default `redis` client) | e.g. `redis://localhost:6379` |

`node dist/main.js <port>` also accepts a port as `argv[2]` for backwards compat.

## HTTP API

### `POST /run`

Execute a snippet of JS inside a transaction. The body of the request is
wrapped as the body of an `async function (gact) { ... }`, so it may use
`await`, `let`/`const`, classes, `return`, etc.

```bash
curl -X POST -H "Content-Type: text/plain" \
  --data 'return 1;' \
  http://127.0.0.1:3000/run
# => 1
```

Accepted request shapes:

- `Content-Type: text/plain` (or any non-JSON type) — the raw body is the code
- `Content-Type: application/json` with `{ "code": "..." }`

Response: JSON-encoded return value of the snippet (or `{}` if it returned
nothing). Errors come back as JSON `{ name, message }` with an appropriate
HTTP status.

### `POST /upload`

Upload one or more class source files as `multipart/form-data`. Each file is
stored in Redis under its `originalname`, so a file uploaded as `Beta.js`
becomes the source loaded by `gact.loadClass("Beta")`.

```bash
curl -X POST \
  -F "file1=@Beta.js" \
  -F "file2=@Gamma.js" \
  http://127.0.0.1:3000/upload
```

### `GET /`

Health check — returns `Online`.

## Writing actor classes

A class source file is itself the body of an `async function (gact) { ... }`
and must `return` the class:

```js
// Beta.js
class Beta extends gact.Actor {
  constructor(gact, id) {
    super(gact, id);
  }
  foo() {
    return 'bar';
  }
}
return Beta;
```

Inside a `/run` snippet, load it once and instantiate:

```js
const Beta = await gact.loadClass('Beta');
const b = new Beta(gact, 'my-beta-id');
b.b = 'b';
return b.actor_id;
```

Subsequent `gact.load("my-beta-id")` calls (even in other transactions) will
auto-load the class by name and rehydrate the actor.

## Writing typed actor classes (new in 0.3)

Phase 1 adds typed base classes (`actjs/actor`, `actjs/event-sourced`,
`actjs/replica`) and a `@handler` decorator. The runtime that powers
them lands in Phase 3.1; for now they're the type contract the rest of
the system targets.

```ts
import { Actor } from 'actjs/actor';
import { handler } from 'actjs/handler';

interface CartState {
  items: Array<{ sku: string; qty: number }>;
}

class Cart extends Actor<CartState> {
  @handler('addItem')
  addItem(args: { sku: string; qty: number }): void {
    this.state.items.push(args);
  }
}
```

Event-sourced classes return events instead of mutating state:

```ts
import { EventSourced } from 'actjs/event-sourced';
import { handler } from 'actjs/handler';

interface LedgerState {
  balance: number;
}
type LedgerEvent = { type: 'Deposited'; amount: number };

class Ledger extends EventSourced<LedgerState, LedgerEvent> {
  initialState(): LedgerState {
    return { balance: 0 };
  }
  reduce(state: LedgerState, e: LedgerEvent): LedgerState {
    return { balance: state.balance + e.amount };
  }
  @handler('deposit')
  deposit(args: { amount: number }): LedgerEvent[] {
    return [{ type: 'Deposited', amount: args.amount }];
  }
}
```

## Running typed actors (new in 0.3)

The Phase 3.1 `Runtime` materializes typed actor classes, runs each
one's mailbox serially, and persists snapshots through the
`StorageDriver`. The in-memory driver is the easy entry point; the
production `ValkeyPgStorageDriver` is wire-compatible.

```ts
import { Runtime } from 'actjs/runtime';
import { MemoryStorageDriver } from 'actjs/storage';
import { asClassName, asVersion, mkActorId } from 'actjs/types';

const driver = new MemoryStorageDriver();
await driver.init();

const runtime = new Runtime(driver);
runtime.register({
  name: asClassName('Counter'),
  version: asVersion('1.0.0'),
  ctor: Counter,
});

const id = mkActorId();
await runtime.tell(asClassName('Counter'), id, 'increment', { by: 5 });
const value = await runtime.call<number>(asClassName('Counter'), id, 'read', {});
// value === 5

await runtime.shutdown();
await driver.close();
```

`tell` is durable: the entry is written to the actor's inbox stream
before it enters the in-memory mailbox, so a crash mid-batch replays
unacked entries on the next activation. `call` is request/response
and rejects with `MailboxFullError` if the mailbox is at capacity.

Event-sourced classes (those extending `EventSourced<S, E>`) work
through the same `Runtime` API. The runtime detects the base class
at activation and switches the commit path: handlers return events,
the host appends them atomically, and state is reduced inline.
Snapshots fire every N events (`snapshotEveryNEvents`, default 100)
and on deactivate.

```ts
import { Runtime } from 'actjs/runtime';
import { MemoryStorageDriver } from 'actjs/storage';

const driver = new MemoryStorageDriver();
await driver.init();

const runtime = new Runtime(driver);
runtime.register({
  name: asClassName('Ledger'),
  version: asVersion('1.0.0'),
  ctor: Ledger,
  snapshotEveryNEvents: 1000,
});

const id = mkActorId();
await runtime.call(asClassName('Ledger'), id, 'deposit', { amount: 100 });
// → ledger emits a `Deposited` event; the runtime persists it and
//   folds it into state via reduce.
```

Cold-starting an ES actor with N events and a snapshot at seq M
reads `[snapshot]` + `[events from M+1 to N]` and rebuilds state by
re-applying `reduce` in seq order.

### Reminders

`Runtime.scheduleReminder(class, id, when, type, payload)` queues a
durable `tell` to fire at `when`. The runtime owns a dispatcher
that polls every 100 ms; deliveries survive a process restart
because the reminder is mirrored to both PG (truth) and Valkey
(live queue).

```ts
await runtime.scheduleReminder(
  asClassName('Pinger'),
  pingerId,
  Date.now() + 60_000, // 1 minute from now
  'ping',
  { reason: 'hourly-check' },
);
```

Phase 4.2 wires this into a user-facing `actjs.scheduleAt(...)`
host bridge that handlers call directly. For now, callers schedule
through the Runtime.

### Class version migrations

When a class is registered at a newer version than a previously-
persisted snapshot, the host runs the class's optional `migrate()`
(SWM) or `migrateEvent()` (ES) before opening the actor to traffic.
The prior snapshot is retained at the sentinel `seq = -1` for the
30-day window so a bad migrate is rollback-able.

```ts
class CartV2 extends Actor<CartV2State> {
  override migrate(prev: unknown, prevVersion: string): CartV2State {
    const old = prev as CartV1State;
    return { ...old, currency: 'USD' };
  }
}
```

## Versioned class registry (new in 0.3, Phase 4.1)

When `DATABASE_URL` (or `POSTGRES_URL`) is set, the server mounts a
versioned class-management API at `/v1/...`. Class source is stored
content-addressed in Postgres; published versions are immutable;
deprecation hides a version from new resolutions but keeps it
queryable for clients pinned to a manifest sha that references it.

```bash
# Publish a class version (placeholder admin gate via header)
curl -X POST http://127.0.0.1:3000/v1/classes/Cart/versions \
  -H "Content-Type: application/json" \
  -H "X-Actjs-Admin: 1" \
  -d '{
    "version": "1.4.2",
    "source": "class Cart extends gact.Actor { /* ... */ } return Cart;",
    "deps": { "Item": "^1.0.0" }
  }'
# → 201 { name: "Cart", version: "1.4.2", sha256: "..." }

# Resolve a dep tree into a pinned manifest
curl 'http://127.0.0.1:3000/v1/manifest?root=Cart@1.4.2'
# → { sha256: "...", resolved: { Cart: "1.4.2", Item: "1.0.9" }, constraints: { ... } }

# List the versions of a class
curl http://127.0.0.1:3000/v1/classes/Cart/versions

# Deprecate a version
curl -X PATCH http://127.0.0.1:3000/v1/classes/Cart/versions/1.4.0 \
  -H "Content-Type: application/json" \
  -H "X-Actjs-Admin: 1" \
  -d '{ "deprecated": true }'
```

The resolver picks the highest non-deprecated version satisfying
every accumulated range and rejects with a structured
`DepConflict` (409) — including the path through deps that
produced each incompatible constraint.

Auth is currently a placeholder: any request carrying
`X-Actjs-Admin: 1` is treated as admin. Phase 5.3 will replace
this with a BYO `auth(req)` hook.

## Demo

`./demo.bash` walks through the API end-to-end against a running server:
trivial snippets, creating linked actors, lazy references, mutating across
transactions, uploading user classes, and `Replica` behavior.

```bash
./demo.bash               # interactive, pauses between steps
AUTO=1 ./demo.bash        # run straight through
ACTJS_URL=http://host:3000 ./demo.bash
```

It uses `curl --fail-with-body`, so any non-2xx response from the server
surfaces immediately with the JSON error body.

## Files

| File                   | Purpose                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `src/main.ts`          | Entry point (built to `dist/main.js`)                         |
| `src/top.ts`           | Express 5 server: `/`, `/run`, `/upload`                      |
| `src/gact.ts`          | Legacy `GAct`, `Actor`, `Aggregate`, `Replica`                |
| `src/error.ts`         | `StatusError` class                                           |
| `src/actor.ts`         | New `Actor<S>` base class                                     |
| `src/event-sourced.ts` | New `EventSourced<S, E>` base class                           |
| `src/replica.ts`       | New `Replica<S>` base class                                   |
| `src/handler.ts`       | `@handler` decorator + `getHandlers`                          |
| `src/types/`           | `ActorId`, `ClassName`, `Version`, `Manifest`, `Envelope<T>`  |
| `src/storage/`         | `StorageDriver` interface + memory & valkey-pg drivers        |
| `src/runtime/`         | `Runtime`, `ActorHost`, `Mailbox` — SWM actor execution       |
| `src/registry/`        | Resolver + publisher (Phase 4.1)                              |
| `src/v1/`              | Express routes for the versioned `/v1/...` API                |
| `migrations/`          | Postgres schema (`0001_init.up.sql`, `.down.sql`)             |
| `ops/`                 | `valkey.conf`, Grafana datasources, `backup.sh`               |
| `src/legacy/shim.ts`   | Re-export path for the legacy classes (`actjs/legacy`)        |
| `src/scratch.ts`       | Standalone smoke test (`npx tsx src/scratch.ts`)              |
| `tests/*.test.ts`      | Vitest unit tests                                             |
| `Beta.js`              | Example `Actor` subclass (uploaded as runtime class source)   |
| `Gamma.js`             | Example `Replica` subclass (uploaded as runtime class source) |
| `demo*_*`              | Snippets POSTed to `/run` by `demo.bash`                      |
| `demo.bash`            | End-to-end demo driver                                        |
| `Dockerfile`           | Multi-stage build, distroless final stage                     |
| `docker-compose.yml`   | Local stack: actjs + Valkey + Postgres                        |
| `tasks/`               | Per-phase implementation tasks + ADRs (see PLAN.md)           |

## Security note

`/run` and `/upload` both execute arbitrary JavaScript inside the server
process. Do not expose this to untrusted callers.
