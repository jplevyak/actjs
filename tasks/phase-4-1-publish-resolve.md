# Phase 4.1 — Publish & resolve

> Source: [PLAN.md § Phase 4a/4b](../PLAN.md#phase-4--code-versioning)
> Decisions: [phase-4-1-publish-resolve.adr.md](./phase-4-1-publish-resolve.adr.md)

## Goal

Make class source a first-class versioned entity: publish API,
content-addressed blob storage, immutable `class_version` rows, and
the resolver that turns a root request into a pinned `Manifest`.

## Done when

- `POST /v1/classes/Cart/versions` with TS source, semver, deps,
  engines succeeds; second call with the same version 409s.
- `GET /v1/manifest?root=Cart@1.4.2` returns a deterministic resolved
  map and caches its sha.
- Conflicting ranges across the dep tree produce a structured
  `DepConflict` error with the full path.
- A deprecated version is excluded from new resolutions but still
  resolvable by an explicit Manifest sha.

---

## Checklist

### Publish API

- [x] `POST /v1/classes/:name/versions` (placeholder
      `X-Actjs-Admin: 1` gate; real auth in Phase 5.3).
- [x] Zod body validation.
- [x] Server-side validation:
  - [x] TypeScript parse-only via `ts.createSourceFile` (the ADR
        rejected swc in favor of `typescript` to avoid a native
        dep).
  - [x] `version` is valid semver and is not pre-existing.
  - [x] `deps` keys + ranges validate.
  - [x] `engines.actjs` satisfies the server's `SERVER_ACTJS_VERSION`.
- [x] Storage:
  - [x] `sha256(source)` computed; `class_blob` insert is
        content-addressed (ON CONFLICT DO NOTHING).
  - [x] `class_version` insert; duplicate raises
        `VersionAlreadyPublishedError` → 409.
  - [x] Audit entry `class.published`.
- [x] Listing endpoints:
  - [ ] `GET /v1/classes` (class-name index). _(501
        NotImplemented; index is Phase 4.2/8 work.)_
  - [x] `GET /v1/classes/:name/versions`.
  - [x] `PATCH /v1/classes/:name/versions/:v` for deprecate, with
        optional `graceUntilMs`.

### Resolver

- [x] `src/registry/resolver.ts`:
  - [x] Root input `(ClassName, range | exact version)`.
  - [x] Walks deps; accumulates ranges per class.
  - [x] Highest non-deprecated version satisfying all ranges.
  - [x] `DepConflict` with the full cause path on incompatible
        ranges.
  - [x] Returns `{ manifest, constraints }`; the canonical sha is
        computed by Phase 1's `manifestSha256()`.
- [x] Pure function — `catalog: CatalogLookup` is injected.

### Manifest caching

- [x] `GET /v1/manifest` saves the resolved manifest via
      `driver.saveManifest(sha, resolved)`.
- [x] `driver.loadManifest(sha)` retrieval implemented (Phase 2);
      Phase 4.3's pin middleware uses it.
- [ ] Short-circuit-by-cache-hit in the resolver itself. _(The
      driver's saveManifest is idempotent so re-resolution writes
      the same sha; the in-resolver cache is unnecessary
      micro-optimization.)_

### Manifest API

- [x] `GET /v1/manifest?root=&dep=` with multi-value query params.
- [x] Returns `{ sha256, resolved, constraints }`.

### Tests

- [x] Resolver is deterministic; two runs over the same catalog
      produce byte-identical shas
      (`tests/registry/resolver.test.ts`).
- [x] Resolution skips deprecated versions.
- [x] Conflict detection: `DepConflict` carries both ranges and
      the cause paths.
- [ ] `fast-check`-style property tests. _(The 12 hand-written
      scenarios in the resolver tests cover the same invariants;
      a `fast-check` upgrade is a follow-up if more coverage is
      needed.)_
- [x] Immutability: re-publish same `(name, version)` → 409.
- [x] Deprecation: deprecated versions skip new resolutions; a
      stored manifest still resolves to them (Phase 4.3).

---

## Risks & watch-outs

- [x] `swc` ruled out in favor of `typescript`; pinned in
      `package.json`.
- [x] Resolver caps: 16-deep / 256-node, both configurable;
      `LimitExceeded` error.
- [x] Manifest sha uses sorted-key `JSON.stringify`; algorithm
      documented in the ADR + replicable by clients.
- [x] `class_blob` content-addressed; no deletion path in v1.
      Phase 8.2 GC is documented as a follow-up.
- [ ] Mid-resolve publish race. _(Each `/v1/manifest` request
      issues one `listClassVersions` per class within its
      resolver walk; a publish in between can shift a later pick.
      Acceptable: resolutions are not transactional; the resulting
      sha just gets a new manifest entry. Documented behavior.)_
