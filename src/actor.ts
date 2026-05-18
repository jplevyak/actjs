import type { ActorId } from './types/ids.js';

/**
 * Base class for single-writer-mailbox (SWM) actors.
 *
 * Subclasses describe their persistent state as the type parameter
 * `S` and implement zero or more `@handler`-decorated methods. The
 * runtime (Phase 3.1) is responsible for materializing `state` from
 * a snapshot, calling lifecycle hooks, and committing on each
 * mailbox turn.
 *
 * Phase 1 contract only: this class defines shape, not behavior.
 * Methods are not invoked by anything in Phase 1; the runtime that
 * does so lands in Phase 3.1.
 */
export abstract class Actor<S extends object = object> {
  /** Populated by the runtime from the persisted snapshot. */
  state!: S;

  /** Populated by the runtime when this actor is materialized. */
  actor_id!: ActorId;

  /** Optional one-time initialization on `create`. */
  onInit?(args: unknown): Promise<void> | void;

  /** Called on each materialization (cold, warm, or hot). */
  onActivate?(): Promise<void> | void;

  /** Called on idle eviction and on graceful shutdown. */
  onDeactivate?(): Promise<void> | void;

  /**
   * Return the value to persist as a snapshot. Override for classes
   * that need a custom serialization (e.g. derived fields that
   * shouldn't be stored).
   */
  snapshot(): S {
    return this.state;
  }

  /**
   * Migrate a persisted snapshot whose `class_version` differs from
   * this class's registered version. Receives the prior state and
   * the prior version string; returns the new state shape.
   *
   * Must be pure: no host bridge, no I/O, no time, no randomness.
   * Phase 3.3 calls this on activation when versions mismatch and
   * writes the prior snapshot to the retention slot (seq = -1)
   * before applying the new state.
   */
  migrate?(prevState: unknown, prevVersion: string): S | Promise<S>;
}
