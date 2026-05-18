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

- [ ] `src/runtime/loader.ts`:
  - [ ] `load(name, version): Promise<ClassCtor>`.
  - [ ] Lookup PG `class_version` to get `sha256`.
  - [ ] Read `class_blob`, decompress, compile with `swc`.
  - [ ] Cache compiled module keyed by sha (per-process LRU, default
        cap 256 entries).
  - [ ] Eviction: oldest unused; never evict if there's an active
        actor referencing it (refcount).

### Host bridge injection

- [ ] `ActjsHost` interface implemented as a per-mailbox-turn object:
  - [ ] `self: ActorRef` — built from owning host.
  - [ ] `call<T>(ref, method, args)` — routes via runtime dispatch;
        threads `manifest` and `causation` from the current request.
  - [ ] `tell(ref, type, payload)` — same plumbing, no wait.
  - [ ] `scheduleAt(when, type, payload)` — driver `enqueueReminder`.
  - [ ] `now()` — process clock, made replaceable for tests.
  - [ ] `log` — pino child logger bound to actor + request ids.
  - [ ] `manifest` — the request-pinned Manifest, read-only.
  - [ ] `abort(reason)` — aborts the current handler with a typed
        error.
- [ ] Lint rule: classes cannot `import 'fs' | 'pg' | 'net' | 'child_process'`.
- [ ] Test: a class attempting forbidden imports fails publish in
      Phase 4.1's compile step (extend that validator now).

### Version policy

- [ ] Class-level `floating: boolean` declared on the class metadata
      record at publish time (already accepted by 4.1; this task
      wires it into the runtime).
- [ ] Activation logic:
  - [ ] Read persisted `class_version` from snapshot.
  - [ ] Read resolved version from request `manifest`.
  - [ ] If sticky and persisted < resolved: do nothing (run old
        code).
  - [ ] If sticky and persisted > resolved: refuse with
        `ManifestRegression` error.
  - [ ] If floating and persisted ≠ resolved: walk migration chain
        (3.3 already implemented this; just connect the flag).
- [ ] `actctl actor migrate <id> <version>` for explicit sticky
      bumps.

### Tests

- [ ] Two coexisting versions: send a call to an actor pinned at
      `1.4.2` while another actor is on `2.0.0`; both succeed,
      different code runs.
- [ ] LRU eviction: load 300 distinct shas; assert the cache size
      stays at the configured cap and that an actively held sha is
      never evicted.
- [ ] Forbidden import rejected at publish.
- [ ] Host bridge: a handler calling `actjs.now()` gets a value
      whose mock can be replaced in tests.
- [ ] Sticky regression: persisted `2.0.0`, requested `^1.0.0` →
      structured error, no execution.
- [ ] Floating + migration: persisted `1.0.0`, requested `^1.0.0`,
      latest is `1.5.0` → migrate, run, snapshot bumped to `1.5.0`.

---

## Risks & watch-outs

- [ ] Compiled modules can leak globals onto `globalThis` if the
      source does silly things. Document and lint, but accept
      we're not sandboxing — write it down in the ADR so it's
      explicit.
- [ ] Refcounting against LRU eviction is a classic source of bugs.
      Prefer a "mark in use, evict on idle scan" pattern over
      decrement-on-release.
- [ ] `swc` compiles to JS; ensure the produced output preserves
      TS class metadata needed by the `@handler` registry. Test
      explicitly.
- [ ] The host bridge is the security boundary. Anything new added
      here (in any future phase) needs ADR-level review.
- [ ] `ManifestRegression` errors will confuse users hot-rolling
      back a deploy. The ADR should commit to an SDK-side hint
      and an `actctl manifest pin <sha>` escape hatch.
