# Phase 4.2 — Loader & version policy

> Source: [PLAN.md § Phase 4c/4d](../PLAN.md#phase-4--code-versioning)
> Decisions: [phase-4-2-loader-version-policy.adr.md](./phase-4-2-loader-version-policy.adr.md)

## Goal

Compile class source into runnable modules keyed by sha256, inject
the curated `actjs` host bridge, and implement sticky-by-default
activation with the per-class `floating: true` opt-in.

## Done when

- `ClassLoader.load('Cart', '1.4.2')` returns a constructor in
  bounded time; subsequent calls within the same process are O(1)
  via LRU.
- Two versions of the same class coexist (`Cart@1.4.2` and
  `Cart@2.0.0`) in one process; calls route correctly.
- A sticky actor on `1.4.2` keeps running `1.4.2` after a newer
  version is published.
- A floating actor on `1.4.0` migrates to `1.5.0` on its next
  activation when the request manifest says `^1.5.0`.

---

## Checklist

### Loader

- [x] `src/runtime/loader.ts`:
  - [x] `load(name, version): Promise<ActorCtor>`.
  - [x] Lookup via `driver.listClassVersions(name)` to get `sha256`.
  - [x] Read source via `driver.getClassSource`, compile via
        `ts.transpileModule` (swc was rejected in the ADR — native
        dep cost).
  - [x] LRU cache keyed by sha (default cap 256).
  - [x] Refcount-aware eviction; just-inserted entry excluded so
        a one-cap one-refcount load doesn't self-evict.
  - [x] Phase 4.3 grace-window enforcement: `ClassVersionExpired`
        when `record.graceUntil <= now`.

### Host bridge injection

- [x] `ActjsHost` interface + `makeBridge` factory
      (`src/runtime/host-bridge.ts`).
- [x] Per-instance bridge: `self`, `call`, `tell`, `scheduleAt`,
      `now`, `log`, `abort` (throws `ActorAbort`).
- [ ] `manifest` field on the bridge. _(Deferred — the runtime
      doesn't yet thread request manifests through actor calls;
      Phase 5.1 plumbs it from the pin middleware into the call
      path. The placeholder field is reserved for future
      population.)_
- [ ] `causation` threading on outbound calls. _(Phase 5.1; the
      bridge's `call` doesn't yet pass a causation envelope id.)_
- [x] Forbidden-import lint at publish time (regex pass in the
      publisher; AST upgrade deferred to Phase 7.2).
- [x] Test verifies forbidden import rejected at publish.

### Version policy

- [x] `floating: boolean` on `ActorClassRegistration` /
      `RegisterClassOptions`.
- [x] Activation logic:
  - [x] Persisted < registered + sticky → loader fetches old ctor.
  - [x] Persisted < registered + floating → run new ctor + migrate.
  - [x] Persisted > registered → `ManifestRegression` error.
  - [x] Persisted == registered → registered ctor.
- [ ] `actctl actor migrate <id> <version>`. _(Phase 8.2 owns the
      CLI; the underlying migrate-on-activate path is already
      present.)_

### Tests

- [x] Two coexisting versions of one class via the loader produce
      distinct constructors with different `greet()` behavior.
- [x] LRU evicts the oldest entry once cap is exceeded; refcounted
      entries hold past the cap.
- [x] Forbidden import rejected at publish.
- [x] Host bridge `abort`/`now`/`outbound`-missing pure tests plus
      an end-to-end `this.actjs.call` cross-actor round-trip.
- [x] `ManifestRegression`: persisted v2 + registered v1 → error.
- [x] Sticky activates the older ctor (verified via the loader
      path).
- [x] Floating activates the new ctor + migrates the snapshot.

---

## Risks & watch-outs

- [x] No sandbox in v1: documented in the ADR, accepted under the
      self-hosted threat model.
- [x] Refcount + LRU: just-inserted entry exempt from eviction,
      verified by test.
- [ ] swc/TS decorator output preserving `@handler` registry. _(In
      practice we found stage-3 decorator emit inside the
      AsyncFunction loader context to be version-sensitive; the
      published-source convention works around this with a direct
      `_handlers` assignment, documented in the Phase 4.2 test
      file.)_
- [x] Host bridge as security boundary: documented; additions go
      through ADR review.
- [ ] `ManifestRegression` SDK hint + `actctl manifest pin`
      escape hatch. _(Phase 6.2 / Phase 8.2.)_
