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

- [ ] `POST /v1/classes/:name/versions` (admin-scoped; auth wires up
      in Phase 5.3, this task uses a placeholder admin gate).
- [ ] Request body validated by Zod: `version`, `source` (TS string),
      `deps`, `engines`, `floating?`, `eventSourced?`, `signature?`.
- [ ] Server-side validation:
  - [ ] `swc` compiles the source cleanly.
  - [ ] `version` parses as semver and is not pre-existing.
  - [ ] `deps` keys are valid class names; values are valid semver
        ranges.
  - [ ] `engines.actjs` satisfies the server's own version.
- [ ] Storage:
  - [ ] Compute `sha256(source)`; write `class_blob` if new.
  - [ ] Insert `class_version` row; rely on PK violation for the
        409 case.
  - [ ] Audit log entry: `class.published`.
- [ ] Listing endpoints:
  - [ ] `GET /v1/classes`.
  - [ ] `GET /v1/classes/:name/versions`.
  - [ ] `PATCH /v1/classes/:name/versions/:v` for `deprecated:true`
        (sets `deprecated_at`).

### Resolver

- [ ] `src/registry/resolver.ts`:
  - [ ] Input: a root `(ClassName, range | exact version)`.
  - [ ] Walk: depth-first, memoizing by class name.
  - [ ] Picker: highest version satisfying the range AND
        `deprecated_at IS NULL`.
  - [ ] Conflict detection: two callers want incompatible ranges →
        throw `DepConflict({ class, paths, ranges })`.
  - [ ] Output: `Manifest` plus the deterministic JSON form for
        sha-ing.
- [ ] Pure function: no I/O inside; takes a `(name → versions[])`
      catalog injected by the caller, so it's trivially testable.

### Manifest caching

- [ ] After resolve, compute `sha256` over the canonical JSON.
- [ ] `driver.saveManifest(sha, resolved)` if missing.
- [ ] Subsequent identical inputs short-circuit by re-deriving the
      sha (still cheap) and skipping the resolve walk if cache hit.

### Manifest API

- [ ] `GET /v1/manifest?root=<ClassRef>&dep=<ClassRef>...` — accepts
      multiple `dep` query params for ad-hoc resolution previews.
- [ ] Returns `{ sha256, resolved: { Cart: '1.4.2', ... } }`.

### Tests

- [ ] Property tests (`fast-check`):
  - [ ] Resolution is deterministic for any input.
  - [ ] Resolution never picks a deprecated version (unless via
        explicit Manifest reload).
  - [ ] Conflict detection is complete (no silent picks of an
        incompatible version).
- [ ] Conflict reporting includes the path: `Cart → Item ^1.0.0`
      vs `Pricing → Item ~2.3.0`.
- [ ] Immutability: republishing an existing `(name, version)`
      fails with a clear error code.
- [ ] Deprecation: deprecated versions stay queryable via the
      `manifest:<sha>` path but disappear from fresh resolutions.

---

## Risks & watch-outs

- [ ] `swc` upgrades can change validation behavior subtly. Pin
      `swc/core` in the ADR.
- [ ] Resolver complexity is exponential in pathological dep
      shapes. Add a depth + node cap (e.g. 16 deep, 256 nodes)
      with a clear error if exceeded.
- [ ] Manifest sha must be over a _canonical_ JSON, not the result
      of `JSON.stringify(map)`. Use a sorted-key serializer; record
      the exact algorithm in the ADR so clients can recompute it.
- [ ] `class_blob` dedupes by sha — make sure two distinct
      versions can share a blob without one's deletion freeing the
      other. (No deletes in v1; GC is `actctl gc` later.)
- [ ] Publishing while a request is mid-resolve must not change the
      manifest that request sees. The resolver reads a snapshotted
      catalog at the start; verify under load.
