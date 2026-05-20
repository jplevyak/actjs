/**
 * The compile-time `actjs` parameter passed to loaded class
 * sources. Exposes the framework's base classes and the
 * `@handler` decorator. Frozen — published source must not
 * mutate it.
 *
 * This is distinct from the per-instance `this.actjs` host bridge
 * (see `host-bridge.ts`) which carries runtime methods. The user
 * sees one identifier; internally the static kit is module-level,
 * the bridge is instance-level.
 */
import { Actor } from '../actor.js';
import { EventSourced } from '../event-sourced.js';
import { handler } from '../handler.js';
import { Replica } from '../replica.js';

export interface ClassKit {
  readonly Actor: typeof Actor;
  readonly EventSourced: typeof EventSourced;
  readonly Replica: typeof Replica;
  readonly handler: typeof handler;
}

export const CLASS_KIT: ClassKit = Object.freeze({
  Actor,
  EventSourced,
  Replica,
  handler,
});
