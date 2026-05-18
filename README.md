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
- Redis running locally (or reachable via `REDIS_URL`)
- `curl` for the demo; `jq` optional for pretty JSON output

## Install & run

```bash
npm install
redis-server &           # if not already running
npm start                # listens on PORT (default 3000)
```

Environment variables:

| Var         | Default                  | Purpose                       |
| ----------- | ------------------------ | ----------------------------- |
| `PORT`      | `3000`                   | HTTP listen port              |
| `REDIS_URL` | (default `redis` client) | e.g. `redis://localhost:6379` |

`node main.js <port>` also accepts a port as `argv[2]` for backwards compat.

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
  foo() { return "bar"; }
}
return Beta;
```

Inside a `/run` snippet, load it once and instantiate:

```js
const Beta = await gact.loadClass("Beta");
const b = new Beta(gact, "my-beta-id");
b.b = 'b';
return b.actor_id;
```

Subsequent `gact.load("my-beta-id")` calls (even in other transactions) will
auto-load the class by name and rehydrate the actor.

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

| File           | Purpose                                                  |
| -------------- | -------------------------------------------------------- |
| `main.js`      | Entry point (`node main.js`)                             |
| `top.js`       | Express 5 server: `/`, `/run`, `/upload`                 |
| `gact.js`      | `GAct`, `Actor`, `Aggregate`, `Replica`                  |
| `error.js`     | `StatusError` class                                      |
| `Beta.js`      | Example `Actor` subclass                                 |
| `Gamma.js`     | Example `Replica` subclass                               |
| `demo*_*`      | Snippets POSTed to `/run` by `demo.bash`                 |
| `demo.bash`    | End-to-end demo driver                                   |
| `x.js`         | Standalone smoke test (`node x.js`)                      |

## Security note

`/run` and `/upload` both execute arbitrary JavaScript inside the server
process. Do not expose this to untrusted callers.
