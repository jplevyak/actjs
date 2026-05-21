/**
 * Framework-agnostic assertion helpers for `@actjs/test`.
 *
 * Each helper either returns silently on success or throws an
 * `AssertionError` whose message highlights the diff between
 * expected and actual. They're framework-agnostic so vitest, jest,
 * or a hand-rolled runner can all consume them — the harness
 * doesn't take a dependency on any matcher API.
 *
 * Three primary surfaces:
 *
 *   - {@link assertSnapshot} — read the actor's current state from
 *     the driver and shallow-equal against an expected shape.
 *   - {@link assertEmitted} — for event-sourced actors, ensure
 *     a given event appears in the actor's event log.
 *   - {@link assertScheduled} — peek the driver's pending
 *     reminders to verify a scheduled `tell`.
 */
import type { TestActor } from './actor-ref.js';
import type { TestRuntime } from './runtime.js';

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestHarnessAssertionError';
  }
}

/**
 * Assert that the actor's current snapshot deep-equals `expected`.
 *
 * Pass `{ partial: true }` to require only the listed fields to
 * match (extra fields on the actor are allowed).
 */
export async function assertSnapshot(
  actor: TestActor,
  expected: object,
  options: { partial?: boolean } = {},
): Promise<void> {
  const state = await currentState(actor);
  if (state === null) {
    throw new AssertionError(
      `assertSnapshot: actor ${actor.class as string}:${actor.id as string} has no state yet`,
    );
  }
  if (options.partial) {
    const record = state as Record<string, unknown>;
    for (const [k, v] of Object.entries(expected)) {
      if (!deepEqual(record[k], v)) {
        throw new AssertionError(
          `assertSnapshot: field "${k}" — expected ${stringify(v)}, got ${stringify(record[k])}`,
        );
      }
    }
    return;
  }
  if (!deepEqual(state, expected)) {
    throw new AssertionError(
      `assertSnapshot mismatch.\n  expected: ${stringify(expected)}\n  actual:   ${stringify(state)}`,
    );
  }
}

/**
 * Read the actor's current state, preferring the live host's
 * in-memory view (so post-call assertions don't have to wait for the
 * snapshot debounce). Falls back to the persisted snapshot when the
 * host isn't currently activated.
 */
async function currentState(actor: TestActor): Promise<unknown> {
  try {
    const host = await actor.runtime.getHost(actor.class, actor.id);
    const state = host.currentState();
    if (state !== null && state !== undefined) return state;
  } catch {
    // No host yet — fall through to the snapshot read.
  }
  const snap = await actor.driver.loadSnapshot(actor.id);
  return snap?.state ?? null;
}

/**
 * Assert that the actor's event log contains at least one event
 * matching `expected` (by type + optional payload subset).
 */
export async function assertEmitted(
  actor: TestActor,
  expected: { type: string; payload?: unknown },
): Promise<void> {
  const events: { type: string; payload: unknown }[] = [];
  for await (const e of actor.driver.readEvents(actor.id, 0n)) {
    events.push({ type: e.type, payload: e.payload });
  }
  const found = events.find((e) => {
    if (e.type !== expected.type) return false;
    if (expected.payload === undefined) return true;
    return matches(expected.payload, e.payload);
  });
  if (!found) {
    throw new AssertionError(
      `assertEmitted: no event matched.\n  expected: ${stringify(expected)}\n  events:   ${stringify(events)}`,
    );
  }
}

/**
 * Assert that the runtime has a pending reminder matching the
 * expected shape.
 *
 * `at` is optional — when supplied it's compared as an absolute
 * epoch-ms value (use `t.now + offset` for relative checks). When
 * omitted, *any* pending reminder of the same `type` matches.
 */
export function assertScheduled(
  t: TestRuntime,
  expected: { type: string; at?: number; payload?: unknown; actorId?: string },
): void {
  const pending = t.driver.peekReminders();
  const found = pending.find(({ when, msg }) => {
    if (msg.type !== expected.type) return false;
    if (expected.at !== undefined && when !== expected.at) return false;
    if (expected.actorId !== undefined && (msg.actorId as string) !== expected.actorId) {
      return false;
    }
    if (expected.payload === undefined) return true;
    return matches(expected.payload, msg.payload);
  });
  if (!found) {
    throw new AssertionError(
      `assertScheduled: no pending reminder matched.\n  expected: ${stringify(expected)}\n  pending:  ${stringify(pending)}`,
    );
  }
}

/**
 * Assert that the actor's snapshot is *missing* from the driver —
 * i.e. it was never materialized (no call/tell touched it).
 */
export async function assertNotMaterialized(actor: TestActor): Promise<void> {
  const snap = await actor.driver.loadSnapshot(actor.id);
  if (snap !== null) {
    throw new AssertionError(
      `assertNotMaterialized: actor ${actor.class as string}:${actor.id as string} has a snapshot at seq ${snap.seq.toString()}`,
    );
  }
}

/* --------------------------------------------------------- Internals */

function stringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  const bo = b as Record<string, unknown>;
  for (const k of ak) {
    if (!deepEqual((a as Record<string, unknown>)[k], bo[k])) return false;
  }
  return true;
}

/** Partial match: every key in `expected` must deep-equal the matching key in `actual`. */
function matches(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if (expected === null || actual === null) return false;
  if (typeof expected !== 'object' || typeof actual !== 'object') return false;
  for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
    if (!deepEqual(v, (actual as Record<string, unknown>)[k])) return false;
  }
  return true;
}
