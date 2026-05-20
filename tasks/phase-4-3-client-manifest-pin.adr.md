# ADR — Phase 4.3: Client-pinned manifests

> Task: [phase-4-3-client-manifest-pin.md](./phase-4-3-client-manifest-pin.md)
> Plan reference: [PLAN.md § Phase 4e](../PLAN.md#4e-client-pinned-manifests)

- **Status:** Accepted
- **Date:** 2026-05-18
- **Decider(s):** project author

## Context

Phase 4.1 produced manifest shas; Phase 4.2 made class versions
loadable. Phase 4.3 closes the loop: the SDK pins a request to a
specific manifest sha, the server honors that pin instead of
re-resolving, and the deprecation lifecycle gets the observability
needed for operators to know when it's safe to remove a class
version.

Constraints carried in:

- Phase 2's `class_version` table already carries `grace_until`.
- Phase 4.1 saves resolved manifests by sha (`driver.saveManifest`).
- The pin contract is server-side only in 4.3 — Phase 6.x emits the
  header from the SDK bundle.
- The full HTTP→actor call routing with manifest threading lives in
  Phase 5.x; 4.3 ships the protocol + observability, not the
  per-call activation wiring (which the loader from 4.2 already
  enforces sticky/floating against the snapshot, not the request).

## Decision

### Header name — **`X-Actjs-Manifest`**

Per the locked decisions table in PLAN.md. The `X-` prefix is
deprecated by RFC 6648 but remains universally recognized; the
unprefixed alternative (`Actjs-Manifest`) trips middleware that
assumes anything-not-`X-` is a known HTTP header. Pick the more
forgiving option.

### Default grace window — **90 days**

When `actctl deprecate` (or `PATCH /v1/classes/.../versions/:v`)
flips a version to deprecated, `grace_until = now() + 90 days`
unless an explicit `graceUntilMs` is supplied. 90 days covers a
typical mobile-app release cadence; operators tune in either
direction.

### Pin observability sampling — **count every request, sample lastSeen 1/100**

The in-process tracker increments a per-sha counter on every
request. The Valkey `manifest:<sha>:lastSeen` write happens for ~1
in 100 requests; precision is fine — operators want "is this
sha still in use today?" not millisecond accuracy. Sampling avoids
~1 write per request just to record metadata.

### Top-N gauge cap — **128 shas**

`clients_by_manifest{sha}` emits the 128 most-used shas; the
remainder collapse into `_other`. Defense against a cardinality
explosion from a misbehaving client that randomizes its pin.

### Hard-delete policy — **soft-delete only**

There is no hard-delete in v1. Past `grace_until`, the loader and
the pin middleware both refuse to serve. The class_version row
stays for audit. A Phase 8.2 admin tool may add a later "purge
expired" sweep.

### Pin enforcement scope — **validation + observability only in v1**

The pin middleware in 4.3 validates the sha, surfaces Warnings,
and records usage. It does NOT yet drive per-request actor
activation against a specific class version (the runtime in 4.2
uses the actor's own persisted `class_version`). That wiring
lands in Phase 5.1 when the Fastify HTTP→actor routes carry the
manifest through to `runtime.call`. Documented as a deliberate
phase boundary.

## Consequences

### Positive

- Operators can deprecate a version, wait the grace window, and
  delete the source — knowing the pin middleware will return 410
  to any client still asking.
- `clients_by_manifest{sha}` is a single number to watch on the
  deprecation runbook.
- The tracker is in-process and cheap; no extra storage write per
  request.

### Negative / trade-offs

- 1/100 sampling means the `lastSeen` lag can be ~100 requests
  for a low-traffic actor. Acceptable; operators want days, not
  microseconds.
- Top-N=128 means a long tail of shas after the cap merges to
  `_other`. Counters stay accurate per top-N but the operator
  can't distinguish individuals beyond.
- 4.3 records pin observability but doesn't yet thread manifests
  through actor calls. A worried operator could be misled into
  thinking "pin is honored" when in fact only validation runs.
  Documented.

### Follow-ups for later phases

- Phase 5.1 (Fastify migration) plumbs the manifest from the pin
  middleware into `runtime.call(...)` so activation respects it.
- Phase 6.1 codegen embeds the manifest sha into the SDK bundle.
- Phase 6.2 SDK reads the Warning header and surfaces it as a
  build-time hint.
- Phase 7.2's admin tooling adds a "purge expired" sweep for the
  class_version table.
- Phase 8.1 metrics endpoint exposes `clients_by_manifest{sha}`
  via the standard Prometheus path.

## Alternatives considered (and why not)

- **Header `Manifest` (no prefix).** RFC 6648-cleaner but trips
  off-the-shelf reverse-proxy denylists. Not worth.
- **Sample at 1/10.** 10x the Valkey writes for 10x more accurate
  freshness. The operator workflow (decide if it's safe to drop
  a version) doesn't need that precision.
- **No top-N cap.** Lets a malicious client own the metric
  endpoint. Hard limit is necessary.
- **Hard-delete after grace.** Tempting for storage hygiene but
  removes the audit trail. Operators clean up explicitly.
- **Drive activation from the pin in 4.3.** Doable but cuts across
  Phase 5's HTTP rewrite. Cleaner phase boundary to validate +
  observe in 4.3, activate in 5.1.

## References

- PLAN.md § Phase 4e
- tasks/phase-4-3-client-manifest-pin.md
- Phase 4.1 manifest storage (`driver.saveManifest` / `driver.loadManifest`)
- Phase 4.2 loader (`ClassLoader.load` — extended here for grace check)
