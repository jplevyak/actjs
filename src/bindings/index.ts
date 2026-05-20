/**
 * Public re-exports for the framework adapters. Consumers
 * typically import directly from the framework-specific entry
 * (`actjs/bindings/react`, `actjs/bindings/svelte`) so unused
 * adapters tree-shake out; this barrel exists for tooling that
 * prefers a single import path.
 */
export {
  getActorStore,
  releaseActorStore,
  selectStore,
  type ActorStore,
  type ActorStoreStatus,
} from './store.js';
