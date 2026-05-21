# Phase 8.2 — actctl CLI & test harness

> Source: [PLAN.md § Phase 8b/8c](../PLAN.md#phase-8--observability--dx)
> Decisions: [phase-8-2-actctl-test-harness.adr.md](./phase-8-2-actctl-test-harness.adr.md)

## Goal

Consolidate `actctl` into one cohesive CLI for every operator task,
and ship `@actjs/test` — the in-process harness that makes unit
testing actor classes pleasant.

**Scope this phase:** `@actjs/test` end-to-end. The `actctl`
consolidation (commander/clipanion, profiles, dev watcher, shell,
remaining subcommands) defers to 8.2b — see the ADR.

## Done when

- [ ] `actctl --help` lists every documented subcommand; each has
      its own `--help` with examples. _(Deferred to 8.2b — the
      existing `codegen` / `key` / `publish` subcommands still
      print help via the hand-rolled dispatcher.)_
- [ ] `actctl dev` watches `packages/classes/`. _(Deferred.)_
- [x] `@actjs/test` lets a developer instantiate an actor against
      an in-memory driver and assert on snapshots, events, and
      emitted reminders.
- [x] `@actjs/test` ships in the published package (`./test` export
      in `package.json`).

---

## Checklist

### actctl consolidation

- [ ] One CLI entry, sub-commands via `commander` or `clipanion`.
      _(Deferred — 8.2b.)_
- [ ] `.actjs/config.toml`, env override, `--profile`. _(Deferred.)_
- [ ] Commands: `dev`, `list`, `deprecate`, `promote`, `shell`,
      `actor inspect`, `actor migrate`, `manifest show`,
      `manifest in-use`, `migrate dry-run`, `logs follow`,
      `audit follow`. _(All deferred — `codegen`, `key add`,
      `key revoke`, `publish` already exist from Phases 6.1
      and 7.2.)_
- [ ] `--json` on every command. _(Deferred.)_

### `@actjs/test` harness

- [x] `TestRuntime` — multi-class in-memory runtime backed by the
      memory storage driver.
- [x] Builders:
  - [x] `TestRuntime.create({ classes: { Cart } })` — register class
        definitions.
  - [x] `t.actor(Cart, init?)` — mint a fresh actor.
  - [x] `await actor.call.addItem({ ... })`.
  - [x] `await actor.tell.invalidate()`.
- [x] Assertions:
  - [x] `assertSnapshot(actor, {...})` (with `partial: true` option).
  - [x] `assertEmitted(actor, { type, payload })` (ES; partial
        payload match).
  - [x] `assertScheduled(t, { type, at?, payload?, actorId? })`.
  - [x] `assertNotMaterialized(actor)`.
- [x] Time control:
  - [x] `t.advanceTime(ms)` — fires due reminders deterministically.
  - [x] `t.now` is the canonical clock used by the host bridge,
        runtime, and reminder dispatcher.
- [x] Multi-actor flows:
  - [x] `t.actor(...)` works across class types so end-to-end
        tests don't need the server.

### Property-test helpers

- [ ] `t.property(arbitraries, async (g) => { ... })`. _(Deferred
      to 8.2c.)_
- [ ] Useful arbitraries. _(Deferred.)_

### Migration replay harness

- [x] `replayMigrations({ ctor, snapshots, targetVersion? })` runs
      every supplied snapshot through `migrate()` and reports the
      per-snapshot diff (success or thrown error).
- [ ] Integrates into `actctl migrate dry-run`. _(Deferred — the CLI integration lands with 8.2b when `actctl migrate dry-run` ships.)_

### Tests of the harness

- [x] The Counter example class has a passing test suite written
      entirely via `@actjs/test`.
- [x] The Ledger (event-sourced) example class has a passing test
      suite written entirely via `@actjs/test`.
- [x] `replayMigrations` self-test (success + failure path).

### Documentation

- [ ] `docs/cli.md` — actctl reference. _(Deferred with the CLI
      consolidation.)_
- [x] `docs/testing.md` — testing patterns and antipatterns.

---

## Risks & watch-outs

- [x] Drift between `@actjs/test` and production runtime is the
      number-one risk. _(The harness uses the same `Runtime` +
      `MemoryStorageDriver` that the unit-test suite exercises
      directly. No mocks, no double bookkeeping.)_
- [x] Test harness time control + reminders interact subtly.
      _(Counter test exercises schedule-then-advanceTime; runaway
      schedules are capped at 10 000 drain iterations.)_
- [ ] `actctl dev` is the most-used command — make it fast.
      _(Deferred with the watcher.)_
- [ ] CLI growth: group by noun. _(Deferred with the
      consolidation.)_
- [ ] Migration dry-run reads prod data via admin token.
      _(Deferred; the replay engine ships now, the prod-data
      reader lands with 8.2b.)_
