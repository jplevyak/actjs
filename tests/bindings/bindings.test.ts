/**
 * Framework-adapter tests.
 *
 * The bindings expose three contracts that frameworks consume:
 *
 *   1. The shared ActorStore (`subscribe`/`getSnapshot`/`destroy`,
 *      reference-counted across observers).
 *   2. The React hooks (tested by simulating React's
 *      `useSyncExternalStore` contract — same `subscribe` is called,
 *      same `getSnapshot` is read).
 *   3. The Svelte store contract (`subscribe(run)` fires once
 *      synchronously with the current value, then on each change).
 *
 * The hooks aren't mounted in a real DOM; that's a follow-up when
 * the repo grows a frontend toolchain. Here we assert the parts a
 * mount would observe.
 */
import { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WS from 'ws';

import { Actor } from '../../src/actor.js';
import { getActorStore, releaseActorStore, selectStore } from '../../src/bindings/index.js';
import { actor, actorValue, loadActor } from '../../src/bindings/svelte.js';
import {
  configureReact,
  useActor,
  useActorCall,
  useActorValue,
  fetchActor,
  type ReactLike,
} from '../../src/bindings/react.js';
import { Client } from '../../src/client/index.js';
import { handler } from '../../src/handler.js';
import { asClassName, asVersion } from '../../src/types/index.js';

import { buildHarness, type TestHarness } from '../server/harness.js';

class Counter extends Actor<{ value: number }> {
  override onInit(): void {
    this.state = { value: 0 };
  }
  @handler('inc')
  inc(args: { by: number }): number {
    this.state.value += args.by;
    return this.state.value;
  }
}

let h: TestHarness;
let baseUrl: string;
let client: Client;

beforeEach(async () => {
  h = await buildHarness();
  h.runtime.register({
    name: asClassName('Counter'),
    version: asVersion('1.0.0'),
    ctor: Counter,
    snapshotDebounceMs: 5,
  });
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = h.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  client = new Client({
    url: baseUrl,
    wsCtor: WS as unknown as ConstructorParameters<typeof Client>[0]['wsCtor'],
  });
  await new Promise((r) => setTimeout(r, 50));
});

afterEach(async () => {
  await client.close();
  await h.close();
});

async function createCounter(): Promise<string> {
  const res = await h.app.inject({ method: 'POST', url: '/v1/actors/Counter', payload: {} });
  return (res.json() as { id: string }).id;
}

/* --------------------------------------------- Shared store */

describe('bindings / shared store', () => {
  it('refcounts: two getActorStore calls share one upstream subscribe', async () => {
    const id = await createCounter();
    const s1 = getActorStore(client, 'Counter', id);
    const s2 = getActorStore(client, 'Counter', id);
    expect(s1).toBe(s2);
    await s1.ready;
    expect(s1.getStatus()).toBe('ready');
    releaseActorStore(s1);
    // After one release, the store is still alive.
    expect(s2.getStatus()).toBe('ready');
    releaseActorStore(s2);
    // After both releases, a fresh call returns a *new* store.
    const s3 = getActorStore(client, 'Counter', id);
    expect(s3).not.toBe(s1);
    releaseActorStore(s3);
  });

  it('subscribe fires when the actor commits', async () => {
    const id = await createCounter();
    const store = getActorStore<{ inc: (a: { by: number }) => Promise<number> }, { value: number }>(
      client,
      'Counter',
      id,
    );
    let fired = 0;
    const unsub = store.subscribe(() => fired++);
    await store.ready;
    fired = 0; // discard the initial-snapshot notification
    await store.call.inc({ by: 7 });
    await new Promise((r) => setTimeout(r, 50));
    expect(fired).toBeGreaterThan(0);
    expect((store.getSnapshot() as { value: number }).value).toBe(7);
    unsub();
    releaseActorStore(store);
  });

  it('selectStore only fires when the selected slice changes', async () => {
    const id = await createCounter();
    const store = getActorStore<{ inc: (a: { by: number }) => Promise<number> }, { value: number }>(
      client,
      'Counter',
      id,
    );
    await store.ready;
    const sel = selectStore(store, (s) => Math.floor((s as { value: number }).value / 10));
    let fired = 0;
    const unsub = sel.subscribe(() => fired++);
    // Two updates in the same "bucket" should fire 0 selected-changes.
    await store.call.inc({ by: 1 });
    await store.call.inc({ by: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(fired).toBe(0);
    // Crossing a 10-boundary fires once.
    await store.call.inc({ by: 10 });
    await new Promise((r) => setTimeout(r, 50));
    expect(fired).toBeGreaterThanOrEqual(1);
    unsub();
    releaseActorStore(store);
  });
});

/* --------------------------------------------- React adapter */

/**
 * Minimal {@link ReactLike} that runs hooks linearly. This isn't a
 * full React simulator — it just records the subscribe/getSnapshot
 * pair `useSyncExternalStore` would consume and exposes a `flush()`
 * to trigger a re-render.
 */
function makeFakeReact(): ReactLike & { flush(): void; lastValue(): unknown } {
  let lastGetSnapshot: (() => unknown) | null = null;
  let lastValue: unknown = undefined;
  let onChange: (() => void) | null = null;

  const memos = new Map<string, unknown>();
  const states = new Map<string, unknown>();

  let memoKey = 0;
  let stateKey = 0;

  return {
    useSyncExternalStore<T>(subscribe: (cb: () => void) => () => void, getSnapshot: () => T): T {
      lastGetSnapshot = getSnapshot;
      if (!onChange) {
        onChange = () => {
          lastValue = lastGetSnapshot!();
        };
        subscribe(onChange);
      }
      lastValue = getSnapshot();
      return lastValue as T;
    },
    useState<T>(initial: T): [T, (next: T | ((prev: T) => T)) => void] {
      const key = `s${stateKey++}`;
      if (!states.has(key)) {
        states.set(key, typeof initial === 'function' ? (initial as () => T)() : initial);
      }
      const cur = states.get(key) as T;
      return [
        cur,
        (next) => {
          const v = typeof next === 'function' ? (next as (p: T) => T)(cur) : next;
          states.set(key, v);
        },
      ];
    },
    useEffect(): void {
      // no-op for the contract test
    },
    useMemo<T>(factory: () => T): T {
      const key = `m${memoKey++}`;
      if (!memos.has(key)) memos.set(key, factory());
      return memos.get(key) as T;
    },
    useCallback<T extends (...args: never[]) => unknown>(fn: T): T {
      return fn;
    },
    useTransition(): [boolean, (callback: () => void) => void] {
      return [false, (cb) => cb()];
    },
    flush(): void {
      memoKey = 0;
      stateKey = 0;
      if (lastGetSnapshot) lastValue = lastGetSnapshot();
    },
    lastValue(): unknown {
      return lastValue;
    },
  };
}

describe('bindings / react', () => {
  it('useActor wires up subscribe/getSnapshot', async () => {
    const fake = makeFakeReact();
    configureReact(fake);
    const id = await createCounter();
    // First "render" — registers via useSyncExternalStore.
    useActor(client, 'Counter', id);
    expect(fake.lastValue()).toBeUndefined(); // no snapshot yet

    // Wait for the snapshot to land + flush the fake re-render.
    await new Promise((r) => setTimeout(r, 50));
    fake.flush();
    expect((fake.lastValue() as { value: number } | undefined)?.value).toBe(0);
  });

  it('useActorValue selects a slice', async () => {
    const fake = makeFakeReact();
    configureReact(fake);
    const id = await createCounter();
    await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${id}/inc`,
      payload: { by: 25 },
    });
    useActorValue<{ inc: (a: { by: number }) => Promise<number> }, { value: number }, number>(
      client,
      'Counter',
      id,
      (s) => Math.floor(s.value / 10),
    );
    await new Promise((r) => setTimeout(r, 50));
    fake.flush();
    expect(fake.lastValue()).toBe(2);
  });

  it('useActorCall returns a typed proxy that calls handlers', async () => {
    const fake = makeFakeReact();
    configureReact(fake);
    const id = await createCounter();
    const { call } = useActorCall<{ inc: (a: { by: number }) => Promise<number> }>(
      client,
      'Counter',
      id,
    );
    const result = await call.inc({ by: 3 });
    expect(result).toBe(3);
  });

  it('fetchActor returns the initial snapshot and manifest sha', async () => {
    const id = await createCounter();
    const result = await fetchActor<{ value: number }>(client, 'Counter', id);
    expect(result.snapshot.value).toBe(0);
    expect(typeof result.manifestSha).toBe('string');
  });
});

/* --------------------------------------------- Svelte adapter */

describe('bindings / svelte', () => {
  it('actor() exposes a store-contract subscribe', async () => {
    const id = await createCounter();
    const store = actor<{ inc: (a: { by: number }) => Promise<number> }, { value: number }>(
      client,
      'Counter',
      id,
    );
    const values: ({ value: number } | undefined)[] = [];
    const loadings: boolean[] = [];
    const unsub = store.subscribe((v) => {
      values.push(v.state);
      loadings.push(v.loading);
    });
    // Synchronous first emission.
    expect(values.length).toBe(1);
    expect(loadings[0]).toBe(true);

    await new Promise((r) => setTimeout(r, 50));
    expect(values.some((v) => v?.value === 0)).toBe(true);
    expect(loadings.some((l) => l === false)).toBe(true);

    await store.call.inc({ by: 11 });
    await new Promise((r) => setTimeout(r, 50));
    expect(values.at(-1)?.value).toBe(11);

    unsub();
    store.destroy();
  });

  it('actorValue() is a readable derived store', async () => {
    const id = await createCounter();
    await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${id}/inc`,
      payload: { by: 5 },
    });
    const derived = actorValue<
      { inc: (a: { by: number }) => Promise<number> },
      { value: number },
      number
    >(client, 'Counter', id, (s) => s.value);
    const seen: (number | undefined)[] = [];
    const unsub = derived.subscribe((v) => seen.push(v));
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.at(-1)).toBe(5);
    unsub();
  });

  it('loadActor() resolves with the snapshot for SSR', async () => {
    const id = await createCounter();
    const result = await loadActor<{ value: number }>(client, 'Counter', id);
    expect(result.snapshot.value).toBe(0);
  });
});

/* --------------------------------------------- Stress test cleanup */

describe('bindings / cleanup', () => {
  it('100 acquire/release cycles leave the registry empty', async () => {
    const id = await createCounter();
    for (let i = 0; i < 100; i++) {
      const s = getActorStore(client, 'Counter', id);
      releaseActorStore(s);
    }
    // The next acquire should produce a fresh store (i.e. the prior
    // one was actually destroyed, not retained).
    const fresh = getActorStore(client, 'Counter', id);
    expect(fresh.getStatus()).toBe('loading');
    releaseActorStore(fresh);
  });
});
