/**
 * Legacy compatibility surface for the pre-Phase-1 actor classes.
 *
 * The new {@link import('../actor.js').Actor}, {@link
 * import('../event-sourced.js').EventSourced}, and {@link
 * import('../replica.js').Replica} bases are the canonical Phase 1+
 * surface. The legacy classes in `../gact.ts` remain runnable via
 * `/run` + `/upload` for the lifetime of the legacy shim.
 *
 * @deprecated The shim sunsets 12 months after Phase 5 ships. Move
 * to the new bases and the versioned `POST /v1/classes/:name/versions`
 * publish API before then.
 */
export {
  Actor as LegacyActor,
  Aggregate as LegacyAggregate,
  Replica as LegacyReplica,
  GAct,
  type RedisLike,
} from '../gact.js';

export { default } from '../gact.js';
