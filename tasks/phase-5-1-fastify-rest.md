# Phase 5.1 — Fastify + REST

> Source: [PLAN.md § Phase 5a](../PLAN.md#phase-5--api-surface-fastify)
> Decisions: [phase-5-1-fastify-rest.adr.md](./phase-5-1-fastify-rest.adr.md)

## Goal

Replace the Express 5 sketch with Fastify. Ship the REST surface
(actor CRUD, call, list, class management) with Zod schemas that
also feed an OpenAPI 3.1 document. WebSocket / SSE / auth come in
5.2 and 5.3.

## Done when

- All routes in PLAN.md § 5a respond correctly with Zod-validated
  request/response shapes.
- `GET /openapi.json` returns the generated document; a contract
  test asserts it byte-matches a committed snapshot.
- Idempotency-Key flow: replaying the same key returns the cached
  response unchanged.
- `/run` is gone from the public surface; only `actctl shell`
  exposes equivalent capability (admin-auth in 5.3).

---

## Checklist

### Fastify scaffolding

- [ ] Replace Express in `top.ts` with Fastify.
- [ ] Plugin layout:
  - [ ] `routes/health.ts`
  - [ ] `routes/actors.ts`
  - [ ] `routes/classes.ts`
  - [ ] `routes/run.ts` — internal use only; routed only when admin
        auth lands in 5.3.
- [ ] `fastify-type-provider-zod` (or equivalent) so route handlers
      are fully typed.
- [ ] Error mapper: `StatusError` → RFC 7807 `problem+json`.

### REST routes

For each route, request schema, response schema, status codes, and a
sample integration test:

- [ ] `GET /v1/health`.
- [ ] `POST /v1/actors/:class` — create; body validated against
      handler `onInit` args; returns `{ id, manifest }`.
- [ ] `GET /v1/actors/:class/:id` — snapshot; respects per-class
      `policy()` (Phase 7).
- [ ] `POST /v1/actors/:class/:id/:method` — invoke; body validated
      against handler args; response carries
      `{ result, manifest, seq? }`.
- [ ] `DELETE /v1/actors/:class/:id` — tombstones in PG; releases
      from runtime.
- [ ] `GET /v1/actors?class=&tag.X=Y` — query against PG `tags` jsonb.
- [ ] `GET /v1/classes` and `/v1/classes/:name/versions`.
- [ ] `POST /v1/classes/:name/versions` (already implemented in 4.1
      — port to Fastify).
- [ ] `PATCH /v1/classes/:name/versions/:v`.
- [ ] `GET /v1/manifest?root=&dep=` (port from 4.1).

### Idempotency

- [ ] Header `Idempotency-Key` accepted on every mutating route.
- [ ] On request: `driver.loadIdempotency(key)` → if hit, return the
      stored response unchanged.
- [ ] On response: `driver.saveIdempotency(key, response, 24h)`.
- [ ] Stored response includes status, headers worth preserving
      (`X-Actjs-Manifest` echo, `Warning`), and body.
- [ ] Test: duplicate POST in flight returns identical response.

### OpenAPI

- [ ] Plugin generates `openapi.json` from registered Zod schemas.
- [ ] `GET /openapi.json` exposes it.
- [ ] Snapshot test: serialize the doc, compare to
      `tests/fixtures/openapi.json`. Fail-on-diff with a clear
      message about which route changed.

### Error model

- [ ] All errors use RFC 7807 `application/problem+json`:
      `{ type, title, status, detail, instance, code, ...extra }`.
- [ ] Framework codes: `DepConflict`, `ManifestUnknown`,
      `ManifestRegression`, `VersionDeprecated`, `Gone`,
      `Forbidden`, `MailboxFull`, `IdempotencyMismatch`,
      `SchemaInvalid`.

### Tests

- [ ] Round-trip for each route against an in-memory driver.
- [ ] Schema validation: malformed bodies produce 400 with a
      `SchemaInvalid` problem document.
- [ ] OpenAPI snapshot stable across runs.
- [ ] Idempotency replay test.
- [ ] Demo: legacy `demo.bash` continues to work behind the shim
      (the legacy routes are kept available under `/legacy/` paths
      until the shim sunsets).

---

## Risks & watch-outs

- [ ] Fastify migration touches every route. Land it in a single
      PR; piecemeal migration is harder than it looks.
- [ ] `fastify-type-provider-zod` upgrades break in subtle ways
      across majors. Pin in the ADR.
- [ ] Idempotency keys grow without bound. The 24h TTL covers it,
      but assert the TTL applies in Valkey (not just at app
      layer).
- [ ] The OpenAPI snapshot test will be the most-reviewed file in
      the repo for a while. Set up a CODEOWNERS entry so schema
      changes require an API-team approval.
- [ ] `policy()` is wired in Phase 7. Until then, every mutating
      route is open to whoever can reach it — keep `/v1/...`
      behind the admin gate during dev.
