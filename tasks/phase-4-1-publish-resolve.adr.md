# ADR — Phase 4.1: Publish & resolve

> Task: [phase-4-1-publish-resolve.md](./phase-4-1-publish-resolve.md)
> Plan reference: [PLAN.md § Phase 4a/4b](../PLAN.md#phase-4--code-versioning)

- **Status:** Accepted
- **Date:** 2026-05-18
- **Decider(s):** project author

## Context

Code-as-data is the keystone of actjs. Phase 4.1 turns the
in-process class registration of Phase 3 into a versioned,
content-addressed publish flow with a resolver that walks dep
trees and produces a pinned `Manifest`. Decisions here propagate
through Phase 4.2 (loader), 4.3 (client-pinned manifests), and
Phase 6.1 (codegen).

Phase 2 already provides the storage primitives (`publishClass`,
`getClassSource`, `listClassVersions`, `deprecateClassVersion`,
`saveManifest`, `loadManifest`). Phase 4.1 builds the engine that
calls them, validates publishes, and resolves dep graphs.

## Decision

### Semver range syntax — **full npm semver**

`semver` package, full range syntax (`^`, `~`, `>=`, `||`, hyphen
ranges, pre-releases). Familiar to every JS developer; well-tested
library; no need to invent a new range grammar.

### Source validation at publish — **TypeScript parse-only**

`typescript` (the package) becomes a runtime dependency. Publish
validates source by calling `ts.createSourceFile`, checking for
syntax-level diagnostics. Type errors are NOT caught here — the
Phase 4.2 loader is the gatekeeper for "does this actually run."

Reasons:

- `typescript` is pure JS (no native module), well-supported, and
  install is ~60 MB which is fine for a Node server. swc would be
  faster but introduces a native dep that has caused real-world
  install pain.
- Catching syntax at publish is a guard against typo'd or empty
  uploads; it does not pretend to be a full compile. Full compile
  with type-checking against actjs's own .d.ts is Phase 4.2 work.

### Manifest canonical JSON — **sorted top-level keys, plain JSON.stringify**

Phase 1's `manifestSha256()` is the contract. Keys are sorted
lexicographically; values are plain strings. No JCS, no custom
serializer. Both client (Phase 6.1) and server compute this from
the same source so byte-identical output is required; sorted-key
`JSON.stringify` is the simplest contract that satisfies that.

### Resolver caps — **16 deep, 256 nodes**

Resolution throws `LimitExceeded` past these. Pathological dep
trees are operator misconfiguration; the caps surface the problem
loudly instead of hanging the request. Configurable per Runtime
for the rare deployment that needs more.

### TS compiler version — **server-side `typescript@^5.6`**

Pin in `package.json`. Phase 4.2's loader compiles with the same
version, so client-side codegen and server-side parsing agree on
what's valid TS.

### Source blob compression — **none in v1**

The Phase 2 codec wraps actor snapshots in gzip. For published
class source, the bytes are stored raw in `class_blob.bytes` —
TS source is typically <10 KB and the duplication benefit (same
sha across versions) doesn't survive byte-level edits anyway. zstd
is the future-default once Node 22 lands (Phase 6).

### Admin gate — **`X-Actjs-Admin` placeholder header**

Phase 5.3 introduces the BYO `auth(req)` hook and proper admin
roles. Phase 4.1's publish endpoint accepts any request that
carries `X-Actjs-Admin: 1`. The placeholder is loud enough that
operators will replace it immediately when they integrate auth.

## Consequences

### Positive

- Resolver is a pure function over an injected catalog lookup.
  Testable in isolation; trivially mocked for property-based
  testing.
- Publish API mirrors `npm publish` semantics: immutable versions,
  content-addressed blobs, deprecation as a flag not a delete.
- Manifest sha is deterministic and computable by any client that
  knows the sorted-key contract — no central authority needed for
  the hash itself.

### Negative / trade-offs

- TS as a runtime dep is heavy. Self-hosters used to small server
  installs will notice. The simplicity of "any TS is parseable
  with the official compiler" justifies the cost.
- Greedy resolver (no backtracking) means tricky dep graphs may
  reject with `DepConflict` even when a valid solution exists.
  Operators tighten ranges in response; npm's resolver has the
  same shape and the same trade-off.
- Parse-only at publish means a publish can succeed for source
  that references unknown classes / missing types. Phase 4.2 catches
  this on first instantiation — late, but loud.

### Follow-ups for later phases

- Phase 4.2 loader compiles + caches modules by sha; same TS
  version as here.
- Phase 4.3 client-pin: the manifest sha computed here is what
  clients send back as `X-Actjs-Manifest`.
- Phase 5.1 (Fastify migration) moves these routes from Express
  to Fastify; engine code (resolver, publisher) stays as-is.
- Phase 5.3 replaces the `X-Actjs-Admin` placeholder with the BYO
  `auth(req)` hook.
- Phase 7.2 adds Ed25519 signature verification at publish.

## Alternatives considered (and why not)

- **swc.** Faster but native. The pain budget for self-hosters
  who hit `node-gyp` errors isn't worth the publish-time speed.
- **esbuild.** Same native-dep concern as swc. Also a transpiler,
  not a typechecker — same value proposition as TS parse-only.
- **Backtracking resolver.** Closer to a SAT-solver. Massively
  more code. Phase 4.1 explicitly punts on this; if the world
  needs it we can layer on top of the current greedy algorithm
  with conflict-driven re-pick.
- **JCS for manifest sha.** Stronger canonical form (handles
  nested objects, numbers, etc.). Overkill for a flat string-to-
  string map. The simpler sorted-key form is sufficient and
  trivially replicable in any language.

## References

- PLAN.md § Phase 4a/4b
- tasks/phase-4-1-publish-resolve.md
- semver: <https://github.com/npm/node-semver>
- Phase 1 manifestSha256: `src/types/manifest.ts`
