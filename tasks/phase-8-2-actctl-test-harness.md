# Phase 8.2 — actctl CLI & test harness

> Source: [PLAN.md § Phase 8b/8c](../PLAN.md#phase-8--observability--dx)
> Decisions: [phase-8-2-actctl-test-harness.adr.md](./phase-8-2-actctl-test-harness.adr.md)

## Goal

Consolidate `actctl` into one cohesive CLI for every operator task,
and ship `@actjs/test` — the in-process harness that makes unit
testing actor classes pleasant.

## Done when

- `actctl --help` lists every documented subcommand; each has its
  own `--help` with examples.
- `actctl dev` watches `packages/classes/`, republishes pre-release
  versions as files save, and the running web app sees updates.
- `@actjs/test` lets a developer instantiate an actor against an
  in-memory driver and assert on snapshots, events, and emitted
  reminders.
- Both ship in the published packages and are versioned with the
  rest of the framework.

---

## Checklist

### actctl consolidation

- [ ] One CLI entry, sub-commands via `commander` or `clipanion`.
- [ ] Configuration:
  - [ ] `.actjs/config.toml` in repo root.
  - [ ] Env override (`ACTJS_URL`, `ACTJS_TOKEN`).
  - [ ] `--profile dev|staging|prod` selects a section.
- [ ] Commands (final inventory; each gets its own subtask if
      missing):
  - [ ] `actctl dev` — hot-reload publish loop against a local
        directory.
  - [ ] `actctl publish [path]` — publish one or more versions.
  - [ ] `actctl list` — classes + their versions.
  - [ ] `actctl deprecate <class>@<ver> [--grace=]`.
  - [ ] `actctl promote <class>@<ver>` — set as latest stable tag.
  - [ ] `actctl shell` — admin REPL backed by `/v1/run`.
  - [ ] `actctl actor inspect <id>`.
  - [ ] `actctl actor migrate <id> <version>`.
  - [ ] `actctl manifest show --root --range`.
  - [ ] `actctl manifest in-use` (from 4.3).
  - [ ] `actctl migrate dry-run` (from 3.3).
  - [ ] `actctl logs follow [--actor=]`.
  - [ ] `actctl audit follow` (from 7.2).
  - [ ] `actctl key add|revoke` (from 7.2).
  - [ ] `actctl codegen [--check]` (from 6.1).
- [ ] Machine-readable output via `--json` on every command.

### `@actjs/test` harness

- [ ] `TestRuntime` — single-class or multi-class in-memory runtime
      backed by the memory storage driver from Phase 2.
- [ ] Builders:
  - [ ] `TestRuntime.create({ Cart })` — register class definitions.
  - [ ] `t.actor(Cart, { ownerId: 'u_42' })` — create an actor.
  - [ ] `await actor.call.addItem({ ... })`.
  - [ ] `await actor.tell.invalidate()`.
- [ ] Assertions:
  - [ ] `expect(actor).toHaveSnapshot({...})`.
  - [ ] `expect(actor).toHaveEmitted({ type: 'ItemAdded', ... })`
        (ES).
  - [ ] `expect(t).toHaveScheduled({ at, type, payload })`.
- [ ] Time control:
  - [ ] `t.advanceTime(ms)` — fires due reminders.
  - [ ] `t.now` is a settable clock used by the host bridge.
- [ ] Multi-actor flows:
  - [ ] `t.actor(...)` works across class types so end-to-end
        tests don't need the server.

### Property-test helpers

- [ ] `t.property(arbitraries, async (g) => { ... })` wraps
      `fast-check` with the test runtime injected.
- [ ] Useful arbitraries: `aValidPrincipal`, `aManifest`,
      `aClassRef`.

### Migration replay harness

- [ ] `t.replayMigrations({ class, snapshots: [...] })` runs every
      committed snapshot through the migration chain; reports
      per-snapshot diff.
- [ ] Integrates into `actctl migrate dry-run`.

### Tests of the harness

- [ ] The Counter and Ledger example classes have a passing test
      suite written entirely via `@actjs/test`.
- [ ] The harness behavior matches the production runtime on the
      conformance test suite from Phase 2.

### Documentation

- [ ] `docs/cli.md` — actctl reference.
- [ ] `docs/testing.md` — testing patterns and antipatterns
      (don't mock the harness; don't reach into private state).

---

## Risks & watch-outs

- [ ] `actctl dev` is the most-used command — make it fast. Watch
      with `chokidar`, debounce publishes, parallel uploads.
- [ ] Drift between `@actjs/test` and production runtime is the
      number-one risk. The conformance test suite is the only thing
      keeping them honest; treat regressions as P0.
- [ ] CLI growth: 15+ subcommands is a lot. Group by noun
      (`actctl actor ...`, `actctl class ...`, `actctl manifest ...`)
      so discoverability holds.
- [ ] Migration dry-run reads prod data via admin token. Make sure
      reads are sampled and that the audit log captures dry-run
      invocations.
- [ ] Test harness time control + reminders interact subtly. Test
      the harness's `advanceTime` against pathological schedules
      (reminders that schedule reminders) before claiming complete.
