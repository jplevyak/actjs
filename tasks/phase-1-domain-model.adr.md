# ADR — Phase 1: Domain model & types

> Task: [phase-1-domain-model.md](./phase-1-domain-model.md)
> Plan reference: [PLAN.md § Phase 1](../PLAN.md#phase-1--domain-model--types)

- **Status:** Accepted
- **Date:** 2026-05-18
- **Decider(s):** project author

## Context

The type vocabulary built here is consumed by every later phase: the
storage layer (Phase 2) writes `Envelope<T>`s and `ActorId`-keyed
snapshots, the runtime (Phase 3) materializes `Actor<S>` and
`EventSourced<S, E>` instances, the resolver (Phase 4) deals in
`Manifest`s, and the SDK (Phases 5/6) sees the user-facing surface.
Decisions made here are expensive to revisit.

Constraints carried in:

- Locked in PLAN.md: TS-only authoring, ESM, single-tenant default,
  hybrid SWM + opt-in ES, sticky-by-default class versioning.
- Phase 0 set us up with strict TS (including
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), stage-3
  decorators as the TypeScript default, Vitest, and an existing
  legacy `gact.ts` + `top.ts` exercised by `demo.bash`.
- The Phase 1 surface must coexist with that legacy code path — the
  current `/run` + `/upload` flow continues to work via the legacy
  shim until Phase 5 ships.

## Decision

### Decorator flavor — **Stage-3 (TC39)**

Default in TypeScript 5.0+. No `experimentalDecorators` flag.
Reasons:

- Native first-class support in modern V8; no Reflect-metadata
  polyfill needed.
- The Stage-3 spec is what the broader JS ecosystem will adopt.
- The legacy/experimental decorators have well-documented foot guns
  around class field initialization order that bite particularly
  hard when stateful classes inherit.

Implementation note: the `@handler` decorator uses
`context.addInitializer` to lazily attach a `_handlers` map to the
constructor on first instantiation, guarding with `hasOwnProperty`
to prevent subclass pollution.

### Branding strategy — **Structural intersection with `__brand`**

```ts
type ActorId = string & { readonly __brand: 'ActorId' };
```

Reasons:

- Zero runtime cost.
- Familiar idiom; every consumer who's written TS for more than
  a year recognizes it.
- A `Symbol`-private-property approach is technically more nominal
  but bleeds runtime overhead into hot paths (object property
  access vs free string).
- A dedicated newtype library (e.g. `ts-brand`) is more weight for
  the same property the structural form already gives us.

The cost — that the brand can be erased by `JSON.parse` returning
plain strings — is mitigated by `asActorId` / `asClassName` /
`asVersion` boundary helpers at every parse site.

### UUID library — **`uuidv7`**

Small (single function, no deps), focused, monotonic guarantees
within a process. Chosen over:

- `uuid`: ~5x the size, mostly carries v1/v3/v4/v5 we don't need.
- Hand-rolled: easy to get wrong on the timestamp + sequence
  monotonicity story.

### Legacy-shim sunset — **12 months after Phase 5 ships**

The shim is a maintenance burden in proportion to how long it
lives. Twelve months gives self-hosters one calendar cycle to
republish classes through the new versioned API. Recorded in
`src/legacy/shim.ts` as a JSDoc `@deprecated` notice tied to a
specific date once Phase 5 lands.

## Consequences

### Positive

- A consumer can `import { Actor, type Manifest } from 'actjs/types'`
  with full type safety and zero runtime imports it doesn't use.
- The decorator surface is what future TS will keep supporting; we
  don't owe upgraders a rewrite when stage-3 stabilizes further.
- The legacy code path stays runnable through Phase 5 — no big-bang
  cut-over required.

### Negative / trade-offs

- Structural branding can be erased at JSON boundaries. The cost is
  per-site discipline (always use the `as*` helpers); the alternative
  was 2x heavier types or runtime tagging.
- Stage-3 decorators on inherited classes need the
  `Object.prototype.hasOwnProperty(ctor, '_handlers')` guard or each
  subclass instance accidentally re-uses its parent's handler map.
- Keeping the legacy `gact.ts` runnable means the new bases are not
  yet what powers `/run`. That bridge is Phase 3 (ActorHost) work;
  Phase 1 just lays down the types.

### Follow-ups for later phases

- Phase 3 (3.1) drives `Actor<S>` from a runtime mailbox; the
  lifecycle hook signatures defined here are the contract.
- Phase 4 reads/writes the `Manifest` shape; the canonical sha
  serializer here is what the resolver must match byte-for-byte.
- Phase 5 documents the legacy sunset date in the deprecation
  banner served on `/run` / `/upload`.

## Alternatives considered (and why not)

- **`experimentalDecorators`.** Closes the door on Stage-3
  ergonomics for the rest of the project's life. No upside vs the
  modern flavor in TS 5.6.
- **A `Brand<T, K>` utility library.** Two more dependencies, same
  outcome.
- **`Reflect.metadata` for handler registration.** Pulls in the
  reflect-metadata polyfill and ties us to legacy decorators. Not
  worth it when `addInitializer` is one line of code.
- **Removing the legacy shim immediately.** Breaks `demo.bash` and
  any external user who has wired up `/run` + `/upload`. Sunset
  with notice is the polite path.

## References

- PLAN.md § Phase 1
- tasks/phase-1-domain-model.md
- TC39 decorators proposal: <https://github.com/tc39/proposal-decorators>
- UUIDv7 spec (draft-04): <https://www.ietf.org/archive/id/draft-peabody-dispatch-new-uuid-format-04.html>
