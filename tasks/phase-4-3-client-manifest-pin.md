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

- [ ] Middleware reads `X-Actjs-Manifest`:
  - [ ] Sha present → load via `driver.loadManifest(sha)` →
        `ctx.manifest`.
  - [ ] Sha unknown → 400 `ManifestUnknown`.
  - [ ] Sha references a *deprecated* class version → response
        gets a `Warning: 299 - "VersionDeprecated"` header and a
        structured warning field in JSON.
  - [ ] Sha references a *removed* class version → 410 `Gone`.
- [ ] WS connect: same handshake; the pin is associated with the
      connection, applied to every JSON-RPC call until the client
      reconnects.

### Server: pin observability

- [ ] Every request log line carries `manifestSha`.
- [ ] Active WS connections expose `manifestSha` for the duration.
- [ ] A periodic reducer (every 30 s) aggregates active connections
      + a sliding window of recent requests into the
      `clients_by_manifest{sha}` gauge.
- [ ] Per-sha last-seen timestamp stored at `manifest:<sha>:lastSeen`
      in Valkey for `actctl manifest in-use`.

### Deprecation lifecycle

- [ ] `class_version` gains a `grace_until` timestamp (set when a
      version is deprecated; default 90 days out — confirm in ADR).
- [ ] After `grace_until` passes, the loader refuses to load the
      version; pins resolving to it return 410.
- [ ] `actctl deprecate <class>@<ver> [--grace=<days>]` writes the
      `grace_until`.

### actctl manifest in-use

- [ ] CLI command reads `clients_by_manifest` (Prom or driver
      side-channel) and `manifest:*:lastSeen` keys.
- [ ] Output groups shas by class:version they reference, so
      operators can answer "is anyone still using Cart@1.4.x?"
- [ ] `--json` flag for machine consumption.
- [ ] Exit code non-zero if any deprecated version is still in use
      (lets CI gate a deletion).

### SDK contract (placeholder; full SDK is Phase 6)

- [ ] Define the header name (`X-Actjs-Manifest`) and JSON-RPC
      meta-field name (`manifest`) in a shared `wire` types
      package consumed by both server and client.
- [ ] Server emits Warning headers in a form the SDK can detect
      and surface to the build pipeline.

### Tests

- [ ] Pin happy path: request with valid sha runs against the pinned
      versions.
- [ ] Pin to deprecated version: response carries Warning; server
      still serves it (within grace).
- [ ] Pin past grace: 410.
- [ ] `actctl manifest in-use` reports active shas after a synthetic
      client makes requests; exits 1 when a deprecated sha is in
      use.
- [ ] Cardinality safety: 1000 distinct shas seen in 10 minutes
      don't explode the metrics endpoint (the gauge has a
      configurable top-N cap).

---

## Risks & watch-outs

- [ ] `clients_by_manifest{sha}` is high-cardinality by design.
      Cap it to top-N most-seen shas and emit an `_other` bucket
      for the rest; record this in the ADR.
- [ ] Warning headers are silently dropped by most browser code.
      The SDK has to surface them deliberately — note it as a
      cross-phase dependency for 6.2.
- [ ] The "grace_until" mechanism is the only thing preventing
      forced deletion from breaking old clients. Don't let
      another path bypass it (e.g. a hard-delete admin endpoint
      without a grace check).
- [ ] Per-sha last-seen requires a Valkey write on every request.
      Sample (1 in N) to keep cost bounded.
- [ ] A misconfigured CDN can pin every client to one sha indefinitely.
      Document the `pin: 'latest'` dev escape; recommend it as a
      compose-time default for staging.
