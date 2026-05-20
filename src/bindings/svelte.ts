/**
 * Svelte adapter for `@actjs/client`.
 *
 * Built around Svelte's store contract — any object with
 * `subscribe(run: (value) => void): () => void` is a readable store
 * that the `$` prefix unwraps. Svelte 5 runes consume the same
 * contract via `$state` derivations or via the same `$` prefix,
 * so the adapter targets both worlds with no version split.
 *
 * Public surface:
 *
 *   actor(client, class, id)          → ActorStoreReadable
 *   actorValue(client, class, id, fn) → ReadableStore<value>
 *   loadActor(client, class, id)      → { snapshot, manifestSha }
 *
 * The bindings declare no Svelte dependency. Consumers import the
 * stores and either `$`-prefix them in `.svelte` files or call
 * `subscribe` directly from `+page.server.ts`.
 */
import type { ActorHandle, CallMap, CallOptions, Client } from '../client/index.js';

import { getActorStore, releaseActorStore, selectStore, type ActorStore } from './store.js';

/** A Svelte-compatible readable store. */
export interface ReadableStore<T> {
  subscribe(run: (value: T) => void, invalidate?: () => void): () => void;
}

/** What `actor(...)` returns — readable + the typed `call` proxy. */
export interface ActorReadableStore<C extends CallMap = CallMap, S = unknown> extends ReadableStore<
  ActorReadableValue<S>
> {
  readonly call: C;
  /** Subscribe to errors (separate channel so the store value stays typed). */
  subscribeError(run: (err: unknown) => void): () => void;
  optimistic(mutator: (draft: S) => void, opts?: CallOptions): Promise<void>;
  /** Tear down the upstream subscription early. */
  destroy(): void;
}

export interface ActorReadableValue<S> {
  /** Current state, undefined until the first snapshot lands. */
  readonly state: S | undefined;
  /** True while waiting for the initial snapshot. */
  readonly loading: boolean;
  /** Most recent subscription error, if any. */
  readonly error: unknown;
}

/* ---------------------------------------------------- actor() */

/**
 * Build a readable store for the given actor. Multiple callers for
 * the same (class, id) share the upstream subscription via the
 * shared store registry; unsubscribing the last consumer drops the
 * upstream.
 */
export function actor<C extends CallMap = CallMap, S = unknown>(
  client: Client,
  className: string,
  id: string,
): ActorReadableStore<C, S> {
  const upstream = getActorStore<C, S>(client, className, id);
  const errorListeners = new Set<(e: unknown) => void>();
  let lastError: unknown = undefined;
  // Reflect upstream errors via the error channel.
  const unsubError = upstream.subscribe(() => {
    const e = upstream.getError();
    if (e !== lastError) {
      lastError = e;
      for (const fn of errorListeners) fn(e);
    }
  });
  let destroyed = false;
  let refCount = 1; // matches the getActorStore reference

  const snapshotValue = (): ActorReadableValue<S> => ({
    state: upstream.getSnapshot(),
    loading: upstream.getStatus() !== 'ready',
    error: upstream.getError(),
  });

  const store: ActorReadableStore<C, S> = {
    subscribe(run) {
      // Svelte's contract: invoke once immediately, then on each change.
      run(snapshotValue());
      const cleanup = upstream.subscribe(() => run(snapshotValue()));
      return () => {
        cleanup();
      };
    },
    subscribeError(run) {
      run(lastError);
      errorListeners.add(run);
      return () => {
        errorListeners.delete(run);
      };
    },
    call: upstream.call,
    optimistic: (mutator, opts) => upstream.optimistic(mutator, opts),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubError();
      while (refCount > 0) {
        releaseActorStore(upstream);
        refCount--;
      }
    },
  };
  return store;
}

/* ---------------------------------------------------- actorValue() */

/**
 * Build a derived readable store for a selected slice of the actor's
 * state. Re-emits only when the selected value changes by `Object.is`.
 */
export function actorValue<C extends CallMap, S, V>(
  client: Client,
  className: string,
  id: string,
  selector: (s: S) => V,
): ReadableStore<V | undefined> {
  const upstream = getActorStore<C, S>(client, className, id);
  const selected = selectStore(upstream, selector);
  return {
    subscribe(run) {
      run(selected.getSnapshot());
      const cleanup = selected.subscribe(() => run(selected.getSnapshot()));
      return () => {
        cleanup();
        releaseActorStore(upstream);
      };
    },
  };
}

/* ---------------------------------------------------- loadActor() */

/**
 * SSR / server-route helper for SvelteKit. Resolves once the initial
 * snapshot arrives.
 */
export async function loadActor<S = unknown>(
  client: Client,
  className: string,
  id: string,
): Promise<{ snapshot: S; manifestSha: string }> {
  const store = getActorStore<CallMap, S>(client, className, id);
  try {
    const snapshot = await store.ready;
    return { snapshot, manifestSha: String(client.manifestPin()) };
  } finally {
    releaseActorStore(store);
  }
}

/* ---------------------------------------------------- types re-export */

export type { ActorHandle, ActorStore };
