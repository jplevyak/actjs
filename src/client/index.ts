/**
 * Public entrypoints for `@actjs/client` (exported as `actjs/client`).
 *
 * The framework-agnostic client; React (Phase 6.3) and Svelte
 * (Phase 6.3) bindings wrap this surface.
 */
export {
  Client,
  RpcError,
  type ActorHandle,
  type CallMap,
  type CallOptions,
  type ClientOptions,
  type ClientWarning,
  type ManifestPin,
  type SubscribeOptions,
} from './client.js';
export type { EsReducer, SubscriptionListener } from './subscriptions.js';
export {
  IndexedDbOfflineQueue,
  MemoryOfflineQueue,
  NoopOfflineQueue,
  type OfflineQueueBackend,
  type OfflineQueueMode,
  type QueuedCall,
} from './offline-queue.js';
export { Transport, type TransportState } from './transport.js';
export type { WebSocketLike, WebSocketCtor } from './ws-shim.js';
