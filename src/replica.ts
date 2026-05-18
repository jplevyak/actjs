import { Actor } from './actor.js';

/**
 * Base class for "read-mostly" derived-view actors.
 *
 * A `Replica` is a regular `Actor<S>` whose snapshot the runtime
 * does NOT persist on idle deactivation. Use cases: in-memory
 * projections of an event stream, cached aggregations, search
 * indexes — anything you'd be happy to rebuild on demand.
 *
 * Mutations made inside a transaction are visible within that
 * transaction but discarded when the actor goes idle. Classes that
 * want some mutations to persist can opt back in with a custom
 * `snapshot()` that returns the durable-only subset.
 */
export abstract class Replica<S extends object = object> extends Actor<S> {
  static readonly persistOnDeactivate = false;
}
