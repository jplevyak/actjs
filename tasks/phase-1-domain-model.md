# Phase 1 — Domain model & types

> Source: [PLAN.md § Phase 1](../PLAN.md#phase-1--domain-model--types)
> Decisions: [phase-1-domain-model.adr.md](./phase-1-domain-model.adr.md)

## Goal

Lock the type vocabulary the rest of the system uses: branded ids,
the `Envelope<T>` wire shape, the `Actor<S>` / `EventSourced<S, E>` /
`Replica<S>` base classes, the `@handler` decorator, and the legacy
shim that keeps today's `/run` + `/upload` working.

## Done when

- `import { Actor, EventSourced, Replica, type Envelope, type Manifest, ... }
from 'actjs/types'` works from a fresh consumer package.
- A toy `Counter` actor written against the new base types compiles
  and round-trips a `tell` end-to-end against an in-memory driver.
- Legacy `Beta` and `Gamma` demo classes still load via the shim
  and pass the existing `demo.bash` integration test.

---

## Checklist

### Branded primitives & envelope

- [ ] `src/types/ids.ts` — branded `ActorId`, `ClassName`, `Version`
      types backed by string; `mkActorId()` returning UUIDv7.
- [ ] `src/types/envelope.ts` — `Envelope<T>` interface as specified
      in PLAN.md Phase 1 (id, ts, actor ref, type, payload,
      idempotencyKey, causation, manifestSha).
- [ ] `src/types/manifest.ts` — `Manifest` as `ReadonlyMap<ClassName,
Version>` with helper to compute its sha256.
- [ ] UUIDv7 source: prefer `uuidv7` package over hand-rolled.

### Actor base classes

- [ ] `src/actor.ts`:
  - [ ] `abstract class Actor<S extends object>` with `state`,
        lifecycle hooks (`onInit?`, `onActivate?`, `onDeactivate?`),
        `snapshot(): S`.
  - [ ] Handler registry on the static class side, populated by the
        decorator.
- [ ] `src/event-sourced.ts`:
  - [ ] `abstract class EventSourced<S extends object, E>` extending
        `Actor<S>`; abstract `reduce(state, event): S` and
        `initialState(): S`; handler return type narrowed to `E[]`.
- [ ] `src/replica.ts`:
  - [ ] `class Replica<S>` extending `Actor<S>` with
        `persistOnDeactivate: false` default.

### Decorator

- [ ] `@handler(name?)` — accepts optional method-name override;
      registers into a static `_handlers` record keyed by name.
- [ ] Type-level guard: a handler signature must match
      `(this, args) => Promise<R> | R` for SWM, or
      `(this, args) => Promise<E[]> | E[]` for ES.

### Legacy shim

- [ ] `src/legacy/shim.ts` re-exports the old `GAct`, `Actor`,
      `Aggregate`, `Replica` names backed by the new bases.
- [ ] `/upload` + `/run` continue to inject a parameter named `gact`
      pointing at a host adapter that satisfies the old API surface.
- [ ] `demo.bash` integration test passes without modification.

### Unit tests

- [ ] Round-trip: snapshot → JSON → restore → same shape.
- [ ] Decorator: registering, listing, and invoking handlers
      preserves `this`.
- [ ] ES: applying a sequence of events through `reduce` matches a
      hand-written reduction.
- [ ] Manifest sha is deterministic (same inputs → same bytes).
- [ ] Shim: importing legacy names produces classes that pass the
      legacy demo expectations.

---

## Risks & watch-outs

- [ ] Branded types interact badly with `JSON.parse` (the parsed
      string isn't branded). Settle on a single boundary helper to
      brand on ingress.
- [ ] Decorators in TypeScript come in two flavors (stage-3 and
      legacy). Pin one in `tsconfig.json` and document it in the
      ADR; the runtime registration code is incompatible across
      them.
- [ ] The shim is a maintenance burden. The ADR should specify a
      hard sunset date (recommend: 12 months after Phase 5 ships).
- [ ] `EventSourced<S, E>`: don't let `S` and `E` drift into mutual
      recursion — keep `E` as a discriminated union of plain
      records.
