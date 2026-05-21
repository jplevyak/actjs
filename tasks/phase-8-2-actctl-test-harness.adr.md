# ADR — Phase 8.2: actctl & test harness

> Task: [phase-8-2-actctl-test-harness.md](./phase-8-2-actctl-test-harness.md)
> Plan reference: [PLAN.md § Phase 8b/8c](../PLAN.md#phase-8--observability--dx)

- **Status:** Accepted
- **Date:** 2026-05-20
- **Decider(s):** John Plevyak

## Context

Phase 8.2 in the task file covers two independent developer
surfaces:

1. `@actjs/test` — the in-process harness developers use to unit-
   test their actor classes.
2. `actctl` — the CLI consolidation (dev watcher, shell, profiles,
   15+ subcommands).

This phase ships **`@actjs/test`** in full. The `actctl` consolidation
work — config profiles, `actctl dev` hot-reload, `actctl shell`, the
remaining subcommands (`list`, `deprecate`, `promote`, `actor
inspect`, `actor migrate`, `manifest show`, `logs follow`, `audit
follow`, `migrate dry-run`) — defer to **8.2b**. The two halves are
independent; landing the test harness first unlocks the developer-
ergonomics story that every later phase relies on.

## Decisions

### Time control API — **single `advanceTime(ms)` knob**

`t.now` is a settable number; `t.advanceTime(ms)` bumps it and
drains due reminders. No fake-timer install, no `vi.useFakeTimers()`
integration, no separate "freeze / unfreeze" API.

**Rationale:** every other timer API the harness might expose can be
expressed in terms of `t.advanceTime`. Fake-timer libraries patch
globals in ways that confuse vitest's own coverage / hot-reload
plumbing and make multi-suite runs harder to reason about.
`advanceTime` is the entire surface; the test owns the clock.

### Assertion style — **framework-agnostic functions, not matchers**

`assertSnapshot(actor, ...)`, `assertEmitted(actor, ...)`,
`assertScheduled(t, ...)`. They throw `AssertionError` with a diff-
style message; vitest / jest / node:test all consume the error
identically.

**Rationale:** matchers (`expect(...).toHaveSnapshot(...)`) bind the
harness to a specific runner's plugin API. Functions keep the surface
small, portable, and easy to compose (`await assertSnapshot(...)`
inside `await Promise.all(...)`).

### Live host fallback for snapshot reads — **prefer in-memory state**

`assertSnapshot` reads from the **live host's `currentState()`**
when one is active, falling back to the persisted snapshot
otherwise. The original design read the driver directly but that
forced tests to either `await t.drain()` after every call or set
`snapshotDebounceMs: 0` on every class registration. The live-host
read makes the harness "just work" without either.

### Reminder dispatch — **`advanceTime` drains, no background loop**

The harness explicitly does not start the production
`ReminderDispatcher` loop. Reminders deliver only when
`advanceTime` / `drainReminders` is called. Multi-wave schedules
(reminders that schedule further reminders) loop until the queue
settles, capped at 10 000 iterations to catch runaway recursion in
test code.

**Rationale:** background timers are the leading source of CI flake
in async-heavy test suites. A single deterministic drain point is
worth the explicitness.

### Class registration shape — **plain object map**

`TestRuntime.create({ classes: { Counter, Ledger } })`. Each value
is either the ctor (default version `1.0.0`) or an object
`{ ctor, version, options }` for overrides.

**Rationale:** developers write `{ Counter }` in 90% of tests; the
expanded form only appears when a test needs to register multiple
versions of the same class (rare). Keeping both forms in one option
covers both.

### Clock plumbing — **`RuntimeOptions.nowMs` cascade**

`Runtime` now takes a `nowMs?: () => number` option. The same clock
flows through:

- the host bridge (`actjs.now()` inside handlers),
- the reminder dispatcher (`popDueReminders(now)`),
- the in-memory driver (already settable via `driver.now =
() => …`).

Production omits `nowMs` and gets `Date.now()` everywhere.

### `actctl` consolidation — **deferred to 8.2b**

`actctl` already has `codegen`, `key add`, `key revoke`, `publish`
(from Phases 6.1 and 7.2). The full consolidation work (commander
/ clipanion / profile config / `actctl dev`) deserves its own
ADR — there's a tooling-vs-scope choice (commander vs clipanion) and
a runtime risk (file-watcher debouncing) that justify holding the
trigger.

## Consequences

### Positive

- A developer writes their first actor test in ten lines, with no
  Docker, no test-server boot, no env vars.
- Assertions are framework-agnostic — the harness ships independent
  of the runner choice.
- The conformance guarantee holds: the harness uses the same
  `Runtime` + `MemoryStorageDriver` that the unit-test suite
  exercises directly.
- Future `actctl migrate dry-run` lands on top of `replayMigrations`
  without redoing the engine.

### Negative / trade-offs

- No CLI consolidation this phase. `actctl --help` still lists only
  the four existing subcommands. Operators who want `actctl dev`
  must wait for 8.2b.
- No fake-timer install means tests that mix `setTimeout` with
  `actjs.scheduleAt` won't have one knob; the harness only
  controls actjs-scheduled work. Documented in
  `docs/testing.md`.
- Multi-wave reminder drain is capped at 10 000 iterations. Beyond
  that the test fails — by design — to surface runaway schedules.

### Follow-ups for later phases

- 8.2b: `actctl` consolidation (commander/clipanion, profiles,
  `actctl dev`, `actctl shell`, the remaining subcommands).
- 8.2c: property-test integration (`fast-check` wrapper) and
  arbitraries (`aValidPrincipal`, `aManifest`, `aClassRef`).

## Alternatives considered (and why not)

- **Matchers (`expect(actor).toHaveSnapshot(...)`).** Locks the
  harness to one runner's plugin shape; framework-agnostic
  functions compose better and ship without a peer-dependency.
- **Sinon fake timers.** Pollutes `globalThis`, complicates vitest's
  isolation, and gives developers two clock APIs to reason about.
  `t.now` + `t.advanceTime` is the entire surface.
- **Server-backed test harness.** Lighting up Fastify + WS for every
  test triples startup time and re-introduces network errors as a
  source of test flake. The in-process `Runtime` is the right
  layer.
- **Mock the storage driver.** Hand-rolled mocks drift from the real
  driver's semantics; the conformance suite plus the in-memory
  driver give us the same guarantee with no double-bookkeeping.

## References

- `src/test/` — `TestRuntime`, `TestActor`, assertions,
  `replayMigrations`.
- `docs/testing.md` — developer-facing testing guide.
- `tests/test-harness/` — Counter, Ledger, and migration replay
  example suites written entirely via `@actjs/test`.
