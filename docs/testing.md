# Testing actor classes with `@actjs/test`

`@actjs/test` is the in-process test harness that lets you exercise
an actor class against a memory-backed runtime — no Postgres, no
Valkey, no HTTP server. It's the same `Runtime` + `MemoryStorageDriver`
that the unit tests in this repo use, wrapped in a developer-
friendly facade.

```ts
import { TestRuntime, assertSnapshot } from 'actjs/test';

const t = await TestRuntime.create({ classes: { Counter } });
const counter = t.actor(Counter);
await counter.call.inc({ by: 5 });
await assertSnapshot(counter, { n: 5 });
await t.close();
```

## What you get

- **`TestRuntime.create({ classes })`** — registers each class at
  `1.0.0` (override via `{ Counter: { ctor: Counter, version: '2.0.0' } }`)
  and returns a handle.
- **`t.actor(Ctor)`** — mints a fresh actor id and returns a
  `TestActor` whose `.call.<method>(args)` and `.tell.<method>(payload)`
  dispatch through the runtime. Multi-actor flows work the same way;
  `t.actor(B)` makes a B alongside an A.
- **`t.now`** — settable clock. Driver, runtime, host bridge, and
  reminder dispatcher all read from this value, so `actjs.now()`
  inside a handler matches what the test sees.
- **`t.advanceTime(ms)`** — bump the clock; any reminders whose
  scheduled time has arrived fire as system-principal `tell` calls,
  in order. Returns the count delivered.
- **`t.drainReminders()`** — fire due reminders at the current clock
  without bumping it. Useful after manual `t.now =` adjustments.
- **`t.drain()`** — wait for every live actor's mailbox to drain.

## Assertions

Framework-agnostic helpers (vitest, jest, node:test all work):

```ts
import { assertSnapshot, assertEmitted, assertScheduled, assertNotMaterialized } from 'actjs/test';

// SWM: assert the current state shape.
await assertSnapshot(counter, { n: 5 });
// Partial match: only the listed keys matter.
await assertSnapshot(counter, { n: 5 }, { partial: true });

// ES: assert an event landed in the log.
await assertEmitted(ledger, { type: 'Deposited', payload: { amount: 10 } });

// Reminders: assert one is pending.
assertScheduled(t, { type: 'ping', actorId: counter.id });

// Hygiene: prove an actor was never materialized.
await assertNotMaterialized(stranger);
```

Snapshots come from the **live host's in-memory state** when one is
active (so post-call assertions don't have to wait for the
snapshot debounce). Falls back to the persisted snapshot when the
actor hasn't been materialized yet.

`assertEmitted` reads the actor's event log (`driver.readEvents`)
directly and matches by `type`. The optional `payload` field is a
partial match — every key on the expected payload must deep-equal
the recorded event.

`assertScheduled` peeks the in-memory driver's reminder queue via
`driver.peekReminders()`. The optional `at` field is an absolute
epoch-ms; use `t.now + offset` for relative checks.

## Time control + reminders

The harness deliberately does **not** start the production reminder-
dispatcher loop. Reminders are fired by `t.advanceTime(ms)` (or
`t.drainReminders()`), so suites stay reproducible — no setTimeout
race, no flaky CI runs.

```ts
@handler('schedulePing')
async schedulePing(args: { delayMs: number }): Promise<void> {
  await this.actjs!.scheduleAt(this.actjs!.now() + args.delayMs, 'ping', {});
}

// In a test:
await counter.call.schedulePing({ delayMs: 1_000 });
expect(await t.advanceTime(999)).toBe(0); // not yet due
expect(await t.advanceTime(1)).toBe(1);   // fires
```

Reminders that schedule further reminders are handled naturally —
`drainReminders` loops until the queue settles (capped at 10k
iterations to catch runaway schedules in test code).

## Migration replay

```ts
import { replayMigrations } from 'actjs/test';

const report = await replayMigrations({
  ctor: Note,
  targetVersion: '2.0.0',
  snapshots: [
    { version: '1.0.0', state: { title: 'a', text: 'hello' } },
    { version: '2.0.0', state: { title: 'b', body: 'world' } },
  ],
});
expect(report.failures).toBe(0);
expect(report.results[0].after).toEqual({ title: 'a', body: 'hello' });
```

Each snapshot runs through a fresh actor instance — no cross-
snapshot state leaks. Errors are captured per-snapshot in the
report instead of aborting the loop; `report.failures` is the
total count.

## Antipatterns

- **Don't mock the harness.** It already uses the same `Runtime` +
  `MemoryStorageDriver` that production code paths use; mocking
  inside that surface defeats the conformance guarantee.
- **Don't reach into private state.** Read through the assertion
  helpers and the public `actor.call.<method>` / `.tell.<method>`
  surface. If a state shape is hard to assert, it usually means
  the handler should expose a read method.
- **Don't `setTimeout` in handlers.** Wall-clock timers don't see
  `t.now`; use `actjs.scheduleAt(...)` so the harness's
  `advanceTime` controls them.
- **Don't share a `TestRuntime` across `it()` cases.** Each test
  should `await TestRuntime.create(...)` in `beforeEach` and
  `await t.close()` in `afterEach`. Reminders that fire across
  test boundaries are the leading cause of flaky suites.

## Authoring tip: keep handlers pure

The harness materializes actors lazily — `t.actor(Counter)` doesn't
hit the driver until the first `.call` / `.tell`. Side effects
that need to be in place at construction time (e.g. seeding
`state`) belong in `onInit` so the runtime owns the contract.
