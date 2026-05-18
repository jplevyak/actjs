import { Actor } from './actor.js';

/**
 * Base class for event-sourced actors.
 *
 * Subclasses describe persistent state `S` and the union of events
 * they emit `E`. Handler methods return `E[]`; the runtime appends
 * them atomically to the actor's event stream and then folds them
 * into state via `reduce`. State is never written directly.
 *
 * Keep `E` as a closed discriminated union of plain records so that
 * `reduce`'s switch is exhaustive and snapshots round-trip through
 * JSON unchanged. Don't put functions, class instances, or Maps
 * inside event payloads.
 */
export abstract class EventSourced<S extends object, E> extends Actor<S> {
  /** The state of a newly-created actor with no prior events. */
  abstract initialState(): S;

  /**
   * Fold one event into the prior state.
   *
   * Must be a pure function: no I/O, no time, no randomness, no
   * cross-actor calls. Determinism is what makes replay-from-log
   * work.
   */
  abstract reduce(state: S, event: E): S;

  /**
   * Transform an event that was appended under an older class version
   * into the current event shape. Called once per historical event
   * during cold-start replay when the event's `classVersion` differs
   * from this class's registered version.
   *
   * Like `Actor.migrate`, must be pure. Returns the new-shape event
   * which is then passed to `reduce`.
   */
  migrateEvent?(prevEvent: unknown, prevVersion: string): E;
}
