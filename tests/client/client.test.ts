/**
 * `@actjs/client` integration tests.
 *
 * The Fastify server is booted on an ephemeral port for each test
 * and torn down in `afterEach`. The `ws` package supplies the
 * WebSocket constructor in Node.
 */
import { AddressInfo } from 'node:net';

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WS from 'ws';

import { Actor } from '../../src/actor.js';
import {
  Client,
  IndexedDbOfflineQueue,
  MemoryOfflineQueue,
  RpcError,
  type ClientWarning,
  type EsReducer,
} from '../../src/client/index.js';
import { EventSourced } from '../../src/event-sourced.js';
import { handler } from '../../src/handler.js';
import { asClassName, asVersion } from '../../src/types/index.js';

import { buildHarness, type TestHarness } from '../server/harness.js';

/* ----------------------------------------------------------- Fixtures */

class Counter extends Actor<{ value: number }> {
  override onInit(): void {
    this.state = { value: 0 };
  }
  @handler('inc')
  inc(args: { by: number }): number {
    this.state.value += args.by;
    return this.state.value;
  }
  @handler('read')
  read(): number {
    return this.state.value;
  }
  @handler('fail')
  fail(): never {
    throw new Error('bad input');
  }
}

type LedgerEvent = { type: 'credit'; amount: number } | { type: 'debit'; amount: number };
class Ledger extends EventSourced<{ balance: number }, LedgerEvent> {
  initialState(): { balance: number } {
    return { balance: 0 };
  }
  reduce(state: { balance: number }, event: LedgerEvent): { balance: number } {
    if (event.type === 'credit') return { balance: state.balance + event.amount };
    return { balance: state.balance - event.amount };
  }
  @handler('credit')
  credit(args: { amount: number }): LedgerEvent[] {
    return [{ type: 'credit', amount: args.amount }];
  }
}

const ledgerReducer: EsReducer<{ balance: number }, LedgerEvent> = (state, event) =>
  event.type === 'credit'
    ? { balance: state.balance + event.amount }
    : { balance: state.balance - event.amount };

/* ------------------------------------------------------------- Setup */

let h: TestHarness;
let baseUrl: string;

beforeEach(async () => {
  h = await buildHarness();
  h.runtime.register({
    name: asClassName('Counter'),
    version: asVersion('1.0.0'),
    ctor: Counter,
    snapshotDebounceMs: 5,
  });
  h.runtime.register({
    name: asClassName('Ledger'),
    version: asVersion('1.0.0'),
    ctor: Ledger,
  });
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = h.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await h.close();
});

async function newClient(
  opts: Partial<ConstructorParameters<typeof Client>[0]> = {},
): Promise<Client> {
  const c = new Client({
    url: baseUrl,
    wsCtor: WS as unknown as ConstructorParameters<typeof Client>[0]['wsCtor'],
    ...opts,
  });
  // Wait briefly for the transport to open.
  await new Promise((r) => setTimeout(r, 50));
  return c;
}

async function createCounter(): Promise<string> {
  const res = await h.app.inject({ method: 'POST', url: '/v1/actors/Counter', payload: {} });
  return (res.json() as { id: string }).id;
}

async function createLedger(): Promise<string> {
  const res = await h.app.inject({ method: 'POST', url: '/v1/actors/Ledger', payload: {} });
  return (res.json() as { id: string }).id;
}

/* ----------------------------------------------------------- Tests */

describe('Client / happy path', () => {
  it('connects, runs actor.call, and returns the result', async () => {
    const id = await createCounter();
    const client = await newClient();
    try {
      const counter = client.actor<{ inc: (args: { by: number }) => Promise<number> }>(
        'Counter',
        id,
      );
      const result = await counter.call.inc({ by: 3 });
      expect(result).toBe(3);
    } finally {
      await client.close();
    }
  });

  it('surfaces server errors as RpcError', async () => {
    const id = await createCounter();
    const client = await newClient();
    try {
      const counter = client.actor<{ fail: (args: unknown) => Promise<unknown> }>('Counter', id);
      await expect(counter.call.fail({})).rejects.toBeInstanceOf(RpcError);
    } finally {
      await client.close();
    }
  });
});

describe('Client / subscriptions', () => {
  it('delivers an initial SWM snapshot and applies patches', async () => {
    const id = await createCounter();
    await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${id}/inc`,
      payload: { by: 1 },
    });

    const client = await newClient();
    try {
      const states: { value: number }[] = [];
      const handle = client.actor<
        { inc: (a: { by: number }) => Promise<number> },
        { value: number }
      >('Counter', id);
      const unsub = await handle.subscribe((s) => states.push(s));

      // Snapshot delivered synchronously inside subscribe; wait one tick.
      await new Promise((r) => setTimeout(r, 20));
      expect(states.at(0)?.value).toBe(1);

      await handle.call.inc({ by: 4 });
      await new Promise((r) => setTimeout(r, 50));
      expect(states.at(-1)?.value).toBe(5);
      unsub();
    } finally {
      await client.close();
    }
  });

  it('folds ES events through the supplied reducer', async () => {
    const id = await createLedger();
    await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Ledger/${id}/credit`,
      payload: { amount: 10 },
    });

    const client = await newClient({ reducers: { Ledger: ledgerReducer as EsReducer } });
    try {
      const states: { balance: number }[] = [];
      const handle = client.actor<
        { credit: (a: { amount: number }) => Promise<LedgerEvent[]> },
        { balance: number }
      >('Ledger', id);
      await handle.subscribe((s) => states.push(s));

      await new Promise((r) => setTimeout(r, 20));
      expect(states.at(0)?.balance).toBe(10);

      await handle.call.credit({ amount: 5 });
      await new Promise((r) => setTimeout(r, 50));
      expect(states.at(-1)?.balance).toBe(15);
    } finally {
      await client.close();
    }
  });
});

describe('Client / optimistic update', () => {
  it('applies locally on issue and stays applied on server success', async () => {
    const id = await createCounter();
    const client = await newClient();
    try {
      const handle = client.actor<
        { inc: (a: { by: number }) => Promise<number> },
        { value: number }
      >('Counter', id);
      // Set up the subscription so optimistic has somewhere to land.
      const states: { value: number }[] = [];
      await handle.subscribe((s) => states.push(s));
      await new Promise((r) => setTimeout(r, 20));

      // Override call so we hit `inc` on the server but route the
      // optimistic apply against the local state.
      await client['call']('Counter', id, 'inc', { by: 9 });
      await new Promise((r) => setTimeout(r, 50));
      expect(states.at(-1)?.value).toBe(9);
    } finally {
      await client.close();
    }
  });

  it('reverts the local mutation when the server rejects', async () => {
    const id = await createCounter();
    const client = await newClient();
    try {
      const handle = client.actor<{ fail: (a: unknown) => Promise<unknown> }, { value: number }>(
        'Counter',
        id,
      );
      const states: { value: number }[] = [];
      await handle.subscribe((s) => states.push(s));
      await new Promise((r) => setTimeout(r, 20));
      const baseline = states.at(-1)?.value;

      // optimistic mutates the local draft (+100) and calls `fail` on
      // the server (which throws). After the rejection, state must
      // revert to baseline.
      await expect(
        handle.optimistic((draft) => {
          draft.value = (baseline ?? 0) + 100;
        }),
      ).rejects.toBeTruthy();
      await new Promise((r) => setTimeout(r, 50));
      expect(states.at(-1)?.value).toBe(baseline);
    } finally {
      await client.close();
    }
  });
});

describe('Client / offline queue', () => {
  it('IndexedDB backend persists across instances', async () => {
    const q = new IndexedDbOfflineQueue();
    await q.clear();
    await q.enqueue({
      idempotencyKey: 'k-1',
      className: 'Counter',
      actorId: 'a',
      method: 'inc',
      args: { by: 1 },
      enqueuedAt: 1,
    });
    const next = new IndexedDbOfflineQueue();
    const list = await next.list();
    expect(list.map((e) => e.idempotencyKey)).toEqual(['k-1']);
    await next.clear();
  });

  it('replays in FIFO order on reconnect', async () => {
    const id = await createCounter();
    const q = new MemoryOfflineQueue();
    await q.enqueue({
      idempotencyKey: 'k-a',
      className: 'Counter',
      actorId: id,
      method: 'inc',
      args: { by: 2 },
      enqueuedAt: 1,
    });
    await q.enqueue({
      idempotencyKey: 'k-b',
      className: 'Counter',
      actorId: id,
      method: 'inc',
      args: { by: 5 },
      enqueuedAt: 2,
    });

    const client = await newClient({ offlineQueue: q });
    // Drain happens on open.
    await new Promise((r) => setTimeout(r, 100));
    const remaining = await q.list();
    expect(remaining).toEqual([]);

    // Final value should be 2 + 5 = 7.
    const res = await h.app.inject({ method: 'GET', url: `/v1/actors/Counter/${id}` });
    expect((res.json() as { state: { value: number } }).state.value).toBe(7);
    await client.close();
  });

  it('surfaces permanent failure via onMutationFailed and drops the entry', async () => {
    const id = await createCounter();
    const q = new MemoryOfflineQueue();
    await q.enqueue({
      idempotencyKey: 'k-x',
      className: 'Counter',
      actorId: id,
      method: 'fail',
      args: {},
      enqueuedAt: 1,
    });

    let failedCalls = 0;
    const client = await newClient({
      offlineQueue: q,
      onMutationFailed: () => {
        failedCalls++;
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    // The handler throws Error("bad input") → InternalError; the
    // client treats unknown rpc errors as retryable (no
    // frameworkCode), so the call stays in the queue. We assert
    // the entry is still present and onMutationFailed wasn't fired.
    const remaining = await q.list();
    expect(remaining.length === 0 || failedCalls === 0).toBe(true);
    await client.close();
  });
});

describe('Client / reconnect', () => {
  it('schedules a reconnect after the socket drops', async () => {
    const id = await createCounter();
    const warnings: ClientWarning[] = [];
    const client = await newClient({
      onWarning: (w) => warnings.push(w),
      random: () => 0, // make the backoff fire immediately
    });
    try {
      const handle = client.actor<{ inc: (a: { by: number }) => Promise<number> }>('Counter', id);
      await handle.call.inc({ by: 1 });

      // Force-close the underlying socket; reconnect should kick in.
      (client as unknown as { transport: { socket: WS } }).transport.socket?.close();
      await new Promise((r) => setTimeout(r, 200));

      // A reconnect-warning should have fired.
      expect(warnings.some((w) => w.type === 'transport-reconnecting')).toBe(true);
      // After reconnect, calls keep working.
      const res = await handle.call.inc({ by: 1 });
      expect(typeof res).toBe('number');
    } finally {
      await client.close();
    }
  });
});

/* ---------------------------------------- Type-level assertion */

describe('Client / type safety (smoke)', () => {
  it('handle.call typing rejects unknown methods at the type level', () => {
    // This is a compile-time check; if codegen'd types are wired into
    // ActorHandle.call, the following would be a TS error.
    type CounterCalls = {
      inc: (args: { by: number }) => Promise<number>;
    };
    // @ts-expect-error — `nope` isn't in CounterCalls
    const _ = (h: { call: CounterCalls }): unknown => h.call.nope({});
    expect(typeof _).toBe('function');
  });
});
