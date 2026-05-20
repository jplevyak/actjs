/**
 * Framework-agnostic store contract used by the React and Svelte
 * adapters.
 *
 * `ActorStore` is a tiny reactive cache around `client.actor(c, id)`:
 *
 *   - `getSnapshot()` returns the current state (`undefined` before
 *     the first snapshot arrives).
 *   - `subscribe(fn)` registers a listener; returns an unsubscribe.
 *   - `call.<method>(args)` proxies to the underlying ActorHandle.
 *   - `optimistic(mutator)` proxies to `ActorHandle.optimistic`.
 *
 * The store is **stable per (client, class, id)**: a registry caches
 * instances so multiple components observing the same actor share
 * one server-side subscription. This is the property React's
 * `useSyncExternalStore` needs to avoid resubscribing on every
 * render, and the property Svelte's store contract assumes for
 * deduplication across components.
 *
 * The store transitions through three lifecycle phases:
 *
 *   `idle` → `loading` → `ready`
 *
 * `loading` covers "subscribe RPC issued, awaiting initial
 * snapshot." Bindings can suspend on this phase. On error the store
 * exposes `getError()` and stays in `loading` so a retry can
 * promote it to `ready` without rebuilding the store.
 */
import type {
  ActorHandle,
  CallMap,
  CallOptions,
  Client,
  SubscriptionListener,
} from '../client/index.js';

export type ActorStoreStatus = 'idle' | 'loading' | 'ready';

export interface ActorStore<C extends CallMap = CallMap, S = unknown> {
  readonly client: Client;
  readonly class: string;
  readonly id: string;
  /** Underlying handle — exposed for advanced usage. */
  readonly handle: ActorHandle<C, S>;
  getSnapshot(): S | undefined;
  getStatus(): ActorStoreStatus;
  getError(): unknown;
  subscribe(listener: () => void): () => void;
  call: C;
  optimistic(mutator: (draft: S) => void, opts?: CallOptions): Promise<void>;
  /** Returns a promise that resolves with the first snapshot. */
  readonly ready: Promise<S>;
  /** Drop the upstream subscription. Idempotent. */
  destroy(): void;
}

interface ActorStoreImpl<C extends CallMap, S> extends ActorStore<C, S> {
  refCount: number;
}

interface Registry {
  stores: Map<string, ActorStoreImpl<CallMap, unknown>>;
}

/* ---------------------------------------------------- Public factory */

/**
 * Returns the canonical store for the (client, class, id) triple.
 * Reference-counted: multiple callers share the same store; the
 * upstream subscription is dropped once the last reference releases.
 */
export function getActorStore<C extends CallMap = CallMap, S = unknown>(
  client: Client,
  className: string,
  id: string,
): ActorStore<C, S> {
  const registry = getRegistry(client);
  const key = `${className}:${id}`;
  let store = registry.stores.get(key) as ActorStoreImpl<C, S> | undefined;
  if (!store) {
    store = createActorStore<C, S>(client, className, id, () => {
      // The store is fully torn down when its refCount hits zero;
      // remove it from the registry so the next observer gets a
      // fresh instance (with a fresh upstream subscribe).
      registry.stores.delete(key);
    });
    registry.stores.set(key, store as unknown as ActorStoreImpl<CallMap, unknown>);
  }
  store.refCount++;
  return store;
}

/** Release a reference previously taken by {@link getActorStore}. */
export function releaseActorStore<C extends CallMap, S>(store: ActorStore<C, S>): void {
  const impl = store as ActorStoreImpl<C, S>;
  impl.refCount--;
  if (impl.refCount <= 0) impl.destroy();
}

/* ---------------------------------------------------- Implementation */

const REGISTRY_KEY = Symbol.for('actjs.bindings.store-registry');

function getRegistry(client: Client): Registry {
  const c = client as unknown as Record<symbol, Registry | undefined>;
  let reg = c[REGISTRY_KEY];
  if (!reg) {
    reg = { stores: new Map() };
    c[REGISTRY_KEY] = reg;
  }
  return reg;
}

function createActorStore<C extends CallMap, S>(
  client: Client,
  className: string,
  id: string,
  onLastRelease: () => void,
): ActorStoreImpl<C, S> {
  const handle = client.actor<C, S>(className, id);
  const listeners = new Set<() => void>();
  let snapshot: S | undefined;
  let status: ActorStoreStatus = 'idle';
  let error: unknown = undefined;
  let unsubscribeUpstream: (() => void) | null = null;
  let destroyed = false;

  let readyResolve: (s: S) => void;
  let readyReject: (e: unknown) => void;
  const ready = new Promise<S>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  // Attach a no-op so a rejection in stores no one is awaiting
  // doesn't surface as an unhandled rejection. External callers can
  // still .catch / await the promise to observe the error.
  ready.catch(() => undefined);

  status = 'loading';
  const upstreamListener: SubscriptionListener<S> = (state) => {
    snapshot = state;
    if (status !== 'ready') {
      status = 'ready';
      readyResolve(state);
    }
    for (const fn of listeners) fn();
  };

  void handle.subscribe(upstreamListener).then(
    (unsub) => {
      if (destroyed) {
        unsub();
        return;
      }
      unsubscribeUpstream = unsub;
    },
    (err) => {
      error = err;
      readyReject(err);
      for (const fn of listeners) fn();
    },
  );

  const store: ActorStoreImpl<C, S> = {
    client,
    class: className,
    id,
    handle,
    refCount: 0,
    getSnapshot: () => snapshot,
    getStatus: () => status,
    getError: () => error,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    call: handle.call,
    optimistic: (mutator, opts) => handle.optimistic(mutator, opts),
    ready,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribeUpstream?.();
      listeners.clear();
      onLastRelease();
    },
  };
  return store;
}

/* ----------------------------------------- Selector layering */

/**
 * Wrap a store so consumers see only `selector(state)`. Useful for
 * the `useActorValue` / `actorValue` hooks: the returned store's
 * `getSnapshot` returns the selected slice, and listeners only fire
 * when that slice changes (`Object.is` equality).
 */
export function selectStore<C extends CallMap, S, V>(
  store: ActorStore<C, S>,
  selector: (s: S) => V,
): {
  getSnapshot(): V | undefined;
  subscribe(listener: () => void): () => void;
} {
  let last: V | undefined;
  let hasLast = false;
  const compute = (): V | undefined => {
    const s = store.getSnapshot();
    if (s === undefined) return undefined;
    return selector(s);
  };
  return {
    getSnapshot() {
      const next = compute();
      if (hasLast && Object.is(next, last)) return last;
      last = next;
      hasLast = true;
      return next;
    },
    subscribe(listener) {
      // Seed `last` with the current selected value so the first
      // upstream notification only fires `listener` if the value
      // actually changed. Otherwise a re-subscribe sees its first
      // commit notification as "different from nothing" and fires.
      last = compute();
      hasLast = true;
      return store.subscribe(() => {
        const next = compute();
        if (Object.is(next, last)) return;
        last = next;
        listener();
      });
    },
  };
}
