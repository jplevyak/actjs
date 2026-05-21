/**
 * Migration replay harness.
 *
 * `replayMigrations({ ctor, snapshots })` walks every supplied
 * snapshot through the actor's `migrate(prevState, prevVersion)`
 * chain and reports the per-snapshot diff. Tests use this to
 * confirm that a migration written today doesn't lose data when
 * applied to historical snapshots; `actctl migrate dry-run` (8.2b)
 * will reuse the same engine against production data.
 *
 * The harness instantiates one fresh actor per snapshot — no
 * cross-snapshot state leaks. Migrations are required to be pure
 * (no `actjs.*` calls); the host bridge is therefore not wired.
 */
import type { Actor } from '../actor.js';

export interface ReplaySnapshot {
  readonly version: string;
  readonly state: unknown;
}

export interface ReplayInput<S extends object = object> {
  readonly ctor: new () => Actor<S>;
  /** Target version the snapshots should end up at. Defaults to '<latest>'. */
  readonly targetVersion?: string;
  readonly snapshots: readonly ReplaySnapshot[];
}

export interface ReplayResult {
  readonly index: number;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly ok: boolean;
  readonly error?: string;
}

export interface ReplayReport {
  readonly results: readonly ReplayResult[];
  readonly failures: number;
}

export async function replayMigrations<S extends object>(
  input: ReplayInput<S>,
): Promise<ReplayReport> {
  const target = input.targetVersion ?? '<latest>';
  const results: ReplayResult[] = [];
  let failures = 0;
  for (let i = 0; i < input.snapshots.length; i++) {
    const snap = input.snapshots[i]!;
    const instance = new input.ctor();
    try {
      if (!instance.migrate) {
        // No migrate function: the snapshot is trusted as-is. The
        // replay still records this so the test can opt to fail.
        results.push({
          index: i,
          fromVersion: snap.version,
          toVersion: target,
          before: snap.state,
          after: snap.state,
          ok: true,
        });
        continue;
      }
      const next = await instance.migrate(snap.state, snap.version);
      results.push({
        index: i,
        fromVersion: snap.version,
        toVersion: target,
        before: snap.state,
        after: next,
        ok: true,
      });
    } catch (err) {
      failures++;
      results.push({
        index: i,
        fromVersion: snap.version,
        toVersion: target,
        before: snap.state,
        after: undefined,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { results, failures };
}
