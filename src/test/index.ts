/**
 * `@actjs/test` — public surface.
 *
 * Two stable entry points:
 *
 *   - {@link TestRuntime.create} — build an in-memory actjs runtime
 *     ready for unit tests. Returns a handle whose `actor(Ctor)` mints
 *     fresh actors, whose `advanceTime(ms)` fires due reminders, and
 *     whose `driver` / `runtime` are exposed for advanced cases.
 *   - {@link assertSnapshot} / {@link assertEmitted} /
 *     {@link assertScheduled} — framework-agnostic helpers that throw
 *     on failure. They work with vitest, jest, node:test, or a
 *     hand-rolled runner.
 *
 * The harness is in-process, deterministic, and free of timers — every
 * effect that touches the clock goes through `t.now` / `t.advanceTime`,
 * so suites stay reproducible.
 */
export {
  TestRuntime,
  type CreateOptions,
  type ClassMap,
  type ClassRegistration,
} from './runtime.js';
export { type TestActor } from './actor-ref.js';
export {
  AssertionError,
  assertEmitted,
  assertNotMaterialized,
  assertScheduled,
  assertSnapshot,
} from './assertions.js';
export {
  replayMigrations,
  type ReplayInput,
  type ReplayReport,
  type ReplayResult,
  type ReplaySnapshot,
} from './replay.js';
