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

- [x] `src/types/ids.ts` — branded `ActorId`/`ClassName`/`Version`/`ClassRef`
      with `as*` boundary helpers and `mkActorId()` over `uuidv7`.
- [x] `src/types/envelope.ts` — `Envelope<T>` + `ActorRef`.
- [x] `src/types/manifest.ts` — `Manifest = ReadonlyMap<ClassName, Version>`
      with deterministic `manifestSha256()`.
- [x] UUIDv7 via the `uuidv7` package.

### Actor base classes

- [x] `src/actor.ts` — `abstract class Actor<S extends object>` with
      `state`, `actor_id`, `onInit?`/`onActivate?`/`onDeactivate?`,
      `snapshot()`. Handler registry attached via the `@handler`
      decorator on the static side.
- [x] `src/event-sourced.ts` — `EventSourced<S, E>` with abstract
      `initialState()` + pure `reduce(state, event)`.
- [x] `src/replica.ts` — `Replica<S>` with
      `static persistOnDeactivate = false`.

### Decorator

- [x] `@handler(name?)` registers via `addInitializer` into a static
      `_handlers` record.
- [ ] Type-level guard on handler signatures. _(The decorator
      accepts any method shape today; per-class typed contracts
      will come from Phase 6.1 codegen.)_

### Legacy shim

- [x] `src/legacy/shim.ts` re-exports `GAct`, `LegacyActor`,
      `LegacyAggregate`, `LegacyReplica` (plus the default export).
- [x] `/upload` + `/run` continue to inject a parameter named `gact`
      pointing at `src/gact.ts`; the new code path uses `actjs`.
- [x] `demo.bash` integration test still passes (CI's `integration`
      job).

### Unit tests

- [x] Round-trip: snapshot → JSON → restore.
- [x] Decorator: register / list / invoke preserves `this`.
- [x] ES: events through `reduce` match a hand reduction.
- [x] Manifest sha is deterministic + order-independent.
- [x] Shim: legacy names import cleanly and preserve inheritance.

---

## Risks & watch-outs

- [x] Branded types + `JSON.parse`: the `as*` helpers are the single
      boundary brand site. Documented.
- [x] Decorator flavor: stage-3 (TC39) chosen and recorded in the
      ADR; `tsconfig.json` has no `experimentalDecorators` flag.
- [x] Shim sunset: 12 months after Phase 5 (recorded in the ADR).
- [x] `E` kept as a discriminated union of plain records;
      `EventSourced` JSDoc states this.
