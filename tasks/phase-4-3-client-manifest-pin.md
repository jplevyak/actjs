# Phase 4.3 — Client-pinned manifests

> Source: [PLAN.md § Phase 4e](../PLAN.md#4e-client-pinned-manifests)
> Decisions: [phase-4-3-client-manifest-pin.adr.md](./phase-4-3-client-manifest-pin.adr.md)

## Goal

Let SDK bundles pin to a specific Manifest sha and have the server
honor that pin instead of re-resolving on every call. Add the
observability needed to deprecate old class versions safely.

## Done when

- A request with `X-Actjs-Manifest: <sha>` uses the stored manifest
  directly; the resolver is skipped.
- A pin to a sha referencing a deprecated class version receives a
  warning on first call and a hard `Gone` after the grace window.
- `actctl manifest in-use` lists currently active manifest shas with
  their resolved versions and approximate client counts.
- `clients_by_manifest{sha}` gauge is scrapeable.

---

## Checklist

### Server: pin handling

- [x] Middleware reads `X-Actjs-Manifest`:
  - [x] Sha present → load via `driver.loadManifest(sha)` →
        `req.manifestPin`.
  - [x] Sha unknown → 400 `ManifestUnknown`.
  - [x] Sha references a _deprecated_ class version → response
        gets a `Warning: 299 - "VersionDeprecated"` header.
  - [x] Sha references a _removed_ class version → 410 `Gone`.
- [ ] WS connect: same handshake; the pin is associated with the
      connection, applied to every JSON-RPC call until the client
      reconnects. _(deferred to Phase 5.2 — WS lands there)_

### Server: pin observability

- [ ] Every request log line carries `manifestSha`. _(deferred to
      Phase 8.1 when pino + the request-log middleware land)_
- [ ] Active WS connections expose `manifestSha` for the duration.
      _(deferred to Phase 5.2)_
- [x] In-process tracker aggregates per-sha counters with a top-N
      cap. _(Phase 8.1 promotes this to a Prometheus gauge; the
      30-second reducer + sliding window are deferred.)_
- [x] Per-sha last-seen recorded via 1/100 sampled
      `saveManifest` (substitute for a dedicated
      `manifest:<sha>:lastSeen` key, which a future driver method
      can add).

### Deprecation lifecycle

- [x] `class_version` gains a `grace_until` timestamp (already on
      the Phase 2 schema; wired here).
- [x] After `grace_until` passes, the loader refuses
      (`ClassVersionExpired`); pins resolving to it return 410.
- [ ] `actctl deprecate <class>@<ver> [--grace=<days>]` writes the
      `grace_until`. _(actctl is Phase 8.2; the underlying
      `PATCH /v1/classes/:name/versions/:v` already accepts
      `graceUntilMs`.)_

### actctl manifest in-use

- [ ] CLI command reads `clients_by_manifest` and
      `manifest:*:lastSeen` keys. _(Phase 8.2 owns the CLI.)_
- [x] `GET /v1/admin/manifests/in-use` returns the underlying
      data so the CLI has something to call.
- [ ] Output groups shas by class:version they reference. _(Phase 8.2.)_
- [ ] `--json` flag. _(Phase 8.2.)_
- [ ] Exit code non-zero if any deprecated version is still in
      use. _(Phase 8.2.)_

### SDK contract (placeholder; full SDK is Phase 6)

- [x] Header name `X-Actjs-Manifest` defined in `pin-middleware.ts`.
      _(A dedicated `@actjs/wire` package + JSON-RPC meta-field
      `manifest` is Phase 5.2 / 6.2 work.)_
- [x] Server emits Warning headers in a form the SDK can detect.

### Tests

- [x] Pin happy path: request with valid sha is recorded by the
      tracker (`tests/v1/manifest-pin.test.ts`).
- [x] Pin to deprecated version: response carries Warning; server
      still serves it.
- [x] Pin past grace: 410.
- [ ] `actctl manifest in-use` test. _(Phase 8.2.)_
- [x] Cardinality safety: tracker tests cover top-N + `_other`
      overflow.

---

## Risks & watch-outs

- [x] `clients_by_manifest{sha}` is high-cardinality by design.
      Cap implemented (default 128, `_other` overflow); rationale
      in the ADR.
- [ ] Warning headers are silently dropped by most browser code.
      _(SDK surfacing is Phase 6.2.)_
- [x] The "grace_until" mechanism is the only thing preventing
      forced deletion from breaking old clients. No hard-delete
      path exists today; ADR records "soft-delete only" as the
      v1 policy.
- [x] Per-sha last-seen requires a Valkey write on every request.
      Sampling at 1/100 implemented; sample rate configurable.
- [ ] A misconfigured CDN can pin every client to one sha
      indefinitely. _(Document the `pin: 'latest'` dev escape
      when the SDK lands in Phase 6.2.)_
