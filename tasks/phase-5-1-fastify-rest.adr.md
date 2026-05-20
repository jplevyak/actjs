# ADR — Phase 5.1: Fastify + REST

> Task: [phase-5-1-fastify-rest.md](./phase-5-1-fastify-rest.md)
> Plan reference: [PLAN.md § Phase 5a](../PLAN.md#phase-5--api-surface-fastify)

- **Status:** Accepted
- **Date:** 2026-05-19
- **Decider(s):** project author

## Context

Phase 4 built the engine — publish, resolve, loader, version
policy, pin. Phase 5.1 puts a proper HTTP surface on it: Fastify
replaces the Express sketch, every route is Zod-validated, OpenAPI
3.1 falls out for free, and the actor REST endpoints
(`POST /v1/actors/:class/:id/:method` and friends) wire the
Runtime to the wire protocol.

Constraints carried in:

- Phase 4.3 left the pin middleware and `clients_by_manifest`
  tracker on Express. They migrate to Fastify hooks here.
- The legacy `demo.bash` flow (POST `/run`, POST `/upload`, GET `/`)
  must keep working — port the routes to Fastify, don't move the
  paths.
- Auth is still the placeholder `X-Actjs-Admin: 1` header; Phase
  5.3 plugs in the BYO `auth(req)` hook.

## Decision

### Type provider — **`fastify-type-provider-zod`**

Zod is already a dependency (Phase 4.1). The type provider gives
us:

- Strongly-typed `request.body` / `request.params` / `request.query`
  inferred from the schema.
- Automatic 400 with the Zod issues on schema mismatch (mapped to
  the `SchemaInvalid` problem-detail).
- One source of truth that feeds OpenAPI via `@fastify/swagger`.

### OpenAPI plugin — **`@fastify/swagger`**

Generates OpenAPI 3.1 (the `openapi: 3.1.0` mode) at boot. The
spec is exposed at `GET /openapi.json`. We do not ship the Swagger
UI viewer; operators who want it pull `@scalar/fastify-api-reference`
in their own deployment.

### OpenAPI snapshot test policy — **fail on any diff**

A committed `tests/fixtures/openapi.json` is byte-compared
against the live spec on every test run. Schema changes show up
in PR diffs as part of the test result. Reviewers see the
contract change instead of having to derive it from a route patch.

Updates require running `UPDATE_OPENAPI=1 npm test` once and
committing the result.

### Problem-detail extension shape — **`{type, title, status, detail, code, ...extras}`**

Standard RFC 7807 envelope plus:

- `code`: the framework code (`DepConflict`, `MailboxFull`, etc.)
  — the SDK switches on this, not on `title` or HTTP status.
- `...extras`: per-error fields (`class`, `expired`, `ranges`,
  `diagnostics`, etc.) embedded at the top level for ease of
  parsing.

### Idempotency-Key TTL — **24 h**

Per the Phase 5.1 task spec. Storage is via the existing
`driver.loadIdempotency` / `saveIdempotency`. Replayed responses
carry the original status + body. The original `Idempotency-Key`
echoes back in the `Idempotency-Key` response header so SDKs can
verify replay.

### Legacy route hosting — **same paths on Fastify**

`POST /run`, `POST /upload`, `GET /` stay at their original paths.
Demo.bash is unchanged. The legacy /run + /upload flow gets
ported to Fastify; the legacy `gact.ts` (Express's old transient
withRedisClient pattern) is preserved verbatim — only the
framework changes.

### Activation-against-pin — **deferred to a follow-up**

Phase 4.3's ADR explicitly carved out "pin drives per-call
activation" as Phase 5.1 work. In practice, that requires
threading the manifest through `Runtime.call` to the loader's
ctor pick, which crosses Phase 4.2's sticky/floating gate. Doable,
but it doubles the size of 5.1 and the value is small until the
SDK actually sends pins.

Phase 5.1 ships everything _except_ per-call activation
override: the pin is validated, deprecation is enforced, the
tracker records, but `runtime.call` still uses the loader's
existing sticky/floating logic against the snapshot. A "Phase
5.4" successor task is the natural place to close that loop;
recorded as a known gap in the CHANGELOG.

## Consequences

### Positive

- The server's hottest hot path is now Fastify, which on JSON
  workloads is materially faster than Express 5. The
  `@fastify/swagger` integration makes OpenAPI maintenance a
  side-effect of writing routes, not a separate document.
- Idempotency-Key turns network retries into a one-line
  client-side contract — important for the SDK and for
  React-server-component fetches.
- The OpenAPI snapshot test catches schema-shape regressions in
  PR diff, the way operators want.

### Negative / trade-offs

- Fastify's plugin model is opinionated; contributors familiar
  with Express need a few days of ramp-up.
- `@fastify/swagger`'s emit isn't perfectly stable across minor
  bumps — the snapshot test will trip on legitimate dep upgrades,
  forcing an `UPDATE_OPENAPI=1` step in the upgrade PR.
- Deferring per-call activation-against-pin means a worried
  reviewer of Phase 5.1 has to read the ADR to understand that
  the pin doesn't _yet_ drive routing. Documented loudly.

### Follow-ups for later phases

- Phase 5.2 mounts the WebSocket / JSON-RPC endpoint on the same
  Fastify instance.
- Phase 5.3 swaps the placeholder admin header for the BYO
  `auth(req)` hook plus a `req.principal`.
- A Phase 5.4 (or 6.x) follow-up wires the manifest pin into
  per-call activation, closing the Phase 4.3 carve-out.
- Phase 8.1 adds the OTel + pino middleware that emits the
  `manifestSha` log field.

## Alternatives considered (and why not)

- **`tsoa` / `nestjs`-style decorator routes.** Heavier, opinionated,
  fights with the codegen pipeline planned for Phase 6.1. Zod-typed
  Fastify is simpler and produces the same OpenAPI artifact.
- **Hand-written OpenAPI document.** Drifts immediately;
  reviewers can't trust it. `@fastify/swagger` is the cheaper
  win.
- **Keep Express, mount Fastify under `/v1/`.** Two frameworks in
  one process for ops to reason about. Worse outcome than a
  one-time migration.
- **Path-prefix legacy routes under `/legacy/`.** Forces an
  immediate `demo.bash` edit + breaks any external user. Cheaper
  to keep the paths and let Phase 5.3 / Phase 6 plan a
  deprecation when the new SDK lands.

## References

- PLAN.md § Phase 5a
- tasks/phase-5-1-fastify-rest.md
- Phase 4.3 ADR (pin enforcement scope carve-out)
- `@fastify/swagger`: <https://github.com/fastify/fastify-swagger>
- `fastify-type-provider-zod`: <https://github.com/turkerdev/fastify-type-provider-zod>
