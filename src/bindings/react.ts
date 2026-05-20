/**
 * React adapter for `@actjs/client`.
 *
 * Exports three hooks:
 *
 *   - `useActor(client, class, id)` — returns the current actor state.
 *     Suspends until the initial snapshot arrives; re-renders on
 *     every commit. Built on `useSyncExternalStore` so concurrent
 *     React doesn't tear during transitions.
 *
 *   - `useActorValue(client, class, id, selector)` — same, but
 *     memoizes the selected slice with `Object.is`.
 *
 *   - `useActorCall(client, class, id)` — returns `{ call, pending,
 *     error, optimistic }`; mutations run inside `useTransition` so
 *     React keeps the existing UI responsive while the call is in
 *     flight.
 *
 * React is a **peer dependency** — actjs declares the hooks but
 * doesn't bundle React itself. The minimal React surface we depend
 * on is described by {@link ReactLike} below; React 18 and React 19
 * both satisfy it.
 */

import type { ActorHandle, CallMap, CallOptions, Client } from '../client/index.js';

import { getActorStore, releaseActorStore, selectStore, type ActorStore } from './store.js';

/* ---------------------------------------------------- React shim */

/**
 * Minimal React API surface — we type only what we use so this file
 * doesn't drag in the full `@types/react` graph. Consumers running
 * the hooks supply React via the {@link configureReact} call (or
 * pass a `react` arg per call); we don't `import React from
 * 'react'` so non-React consumers get zero pull.
 */
export interface ReactLike {
  useSyncExternalStore<T>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T;
  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void];
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T;
  useTransition(): [boolean, (callback: () => void) => void];
  use?<T>(promise: Promise<T>): T;
}

let configuredReact: ReactLike | null = null;

/**
 * Install the React instance the hooks should use. Call once at app
 * startup with `configureReact(React)` — typically in your entry
 * file alongside `createRoot`.
 *
 * In tests / non-React contexts you can pass any object that
 * satisfies {@link ReactLike}.
 */
export function configureReact(react: ReactLike): void {
  configuredReact = react;
}

function requireReact(): ReactLike {
  if (!configuredReact) {
    throw new Error(
      'actjs React hooks: call `configureReact(React)` before using `useActor`. ' +
        'See docs/bindings.md.',
    );
  }
  return configuredReact;
}

/* ---------------------------------------------------- useActor */

export interface UseActorOptions {
  /** When true, throws the loading promise so React Suspense kicks in. */
  readonly suspend?: boolean;
}

/**
 * Subscribe to an actor; returns the current state.
 *
 * - Default: returns `undefined` until the first snapshot arrives.
 * - With `{ suspend: true }`: throws the in-flight ready promise so
 *   `<Suspense>` shows the fallback until the snapshot lands.
 */
export function useActor<C extends CallMap = CallMap, S = unknown>(
  client: Client,
  className: string,
  id: string,
  options: UseActorOptions = {},
): S | undefined {
  const R = requireReact();
  const store = useActorStore<C, S>(R, client, className, id);
  const value = R.useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );
  if (options.suspend && value === undefined) {
    const err = store.getError();
    if (err) throw err;
    // Throw the ready promise; React Suspense will retry on resolve.
    throw store.ready;
  }
  return value;
}

/* ---------------------------------------------------- useActorValue */

/**
 * Subscribe to a selected slice of an actor's state. Only re-renders
 * when the selected value changes by `Object.is`.
 */
export function useActorValue<C extends CallMap, S, V>(
  client: Client,
  className: string,
  id: string,
  selector: (state: S) => V,
): V | undefined {
  const R = requireReact();
  const store = useActorStore<C, S>(R, client, className, id);
  // Stable selector ref so the selectStore object identity is
  // preserved across renders.
  const selectorRef = R.useMemo(() => selector, [selector]);
  const selected = R.useMemo(() => selectStore(store, selectorRef), [store, selectorRef]);
  return R.useSyncExternalStore(
    (cb) => selected.subscribe(cb),
    () => selected.getSnapshot(),
    () => selected.getSnapshot(),
  );
}

/* ---------------------------------------------------- useActorCall */

export interface UseActorCall<C extends CallMap, S> {
  /** Proxy of typed call methods. Each returns a Promise. */
  readonly call: C;
  /** True while any call dispatched through this hook is pending. */
  readonly pending: boolean;
  /** Most recent error from a call made through this hook. */
  readonly error: unknown;
  /** Issue an optimistic mutation. */
  readonly optimistic: ActorHandle<C, S>['optimistic'];
}

export function useActorCall<C extends CallMap = CallMap, S = unknown>(
  client: Client,
  className: string,
  id: string,
): UseActorCall<C, S> {
  const R = requireReact();
  const store = useActorStore<C, S>(R, client, className, id);
  const [pending, startTransition] = R.useTransition();
  const [error, setError] = R.useState<unknown>(null);

  const handle = store.handle;
  // Wrap each `call.<method>` so calls are dispatched inside a
  // transition. Storing a Proxy in a ref avoids rebuilding the
  // proxy object on every render.
  const wrappedCall = R.useMemo<C>(() => {
    return new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (typeof prop !== 'string') return undefined;
          return (args: unknown, opts?: CallOptions) => {
            const methods = handle.call as unknown as Record<
              string,
              (a: unknown, o?: CallOptions) => Promise<unknown>
            >;
            const fn = methods[prop];
            if (!fn) {
              return Promise.reject(new Error(`actor has no method "${prop}"`));
            }
            return new Promise<unknown>((resolve, reject) => {
              startTransition(() => {
                void fn(args, opts).then(
                  (r) => {
                    setError(null);
                    resolve(r);
                  },
                  (err) => {
                    setError(err);
                    reject(err);
                  },
                );
              });
            });
          };
        },
      },
    ) as C;
  }, [handle, startTransition]);

  const optimistic = R.useCallback<typeof handle.optimistic>(
    (mutator, opts) => handle.optimistic(mutator, opts),
    [handle],
  );

  return { call: wrappedCall, pending, error, optimistic };
}

/* ---------------------------------------------------- shared hook */

/**
 * Acquires (and on unmount, releases) the shared ActorStore for the
 * (client, class, id) triple. The store is reference-counted, so
 * remounts in StrictMode don't tear down the upstream subscription.
 */
function useActorStore<C extends CallMap, S>(
  R: ReactLike,
  client: Client,
  className: string,
  id: string,
): ActorStore<C, S> {
  const store = R.useMemo(
    () => getActorStore<C, S>(client, className, id),
    [client, className, id],
  );
  R.useEffect(() => {
    // The store was acquired (ref count +1) in the useMemo factory;
    // release on unmount.
    return () => releaseActorStore(store);
  }, [store]);
  return store;
}

/* ---------------------------------------------------- RSC helper */

/**
 * Server-side fetch of an actor's current snapshot. Suitable for
 * React Server Components and for SvelteKit `+page.server` load
 * functions alike.
 *
 * Returns `{ snapshot, manifestSha }`. The snapshot is whatever
 * `client.actor(c, id).subscribe()` would deliver first; pass it
 * into a client component as a prop to skip the loading state.
 */
export async function fetchActor<S = unknown>(
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
