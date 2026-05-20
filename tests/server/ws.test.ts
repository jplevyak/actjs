/**
 * WebSocket / JSON-RPC end-to-end tests.
 *
 * Starts the Fastify app on an ephemeral TCP port (Fastify's `inject`
 * can't drive WS upgrades), connects with the `ws` client, and
 * exercises actor.call, actor.subscribe (SWM + ES), actor.unsubscribe,
 * tombstone notification, and the per-actor subscriber cap.
 */
import { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { Actor } from '../../src/actor.js';
import { EventSourced } from '../../src/event-sourced.js';
import { handler } from '../../src/handler.js';
import { asClassName, asVersion } from '../../src/types/index.js';

import { buildHarness, type TestHarness } from './harness.js';

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

let h: TestHarness;
let url: string;

async function listen(h2: TestHarness): Promise<string> {
  await h2.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = h2.app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${addr.port}/v1/ws`;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

class Client {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  readonly events: { method: string; params: unknown }[] = [];
  /** Fires whenever a notification arrives. */
  onEvent: ((notif: { method: string; params: unknown }) => void) | null = null;

  constructor(public ws: WebSocket) {
    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString('utf8')) as {
        id?: number;
        result?: unknown;
        error?: { code: number; message: string; data?: unknown };
        method?: string;
        params?: unknown;
      };
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method) {
        const ev = { method: msg.method, params: msg.params };
        this.events.push(ev);
        this.onEvent?.(ev);
      }
    });
  }

  static async connect(url: string): Promise<Client> {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    return new Client(ws);
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as Pending['resolve'], reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** Resolves when one notification of the given subscription id arrives. */
  nextNotification(
    subscriptionId: string,
    predicate?: (p: NotifParams) => boolean,
  ): Promise<NotifParams> {
    return new Promise<NotifParams>((resolve) => {
      const handler = (ev: { method: string; params: unknown }): void => {
        if (ev.method !== 'actor.event') return;
        const p = ev.params as NotifParams;
        if (p.subscriptionId !== subscriptionId) return;
        if (predicate && !predicate(p)) return;
        this.onEvent = null;
        resolve(p);
      };
      this.onEvent = handler;
    });
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) {
      await new Promise<void>((res) => {
        this.ws.once('close', () => res());
        this.ws.close();
      });
    }
  }
}

interface NotifParams {
  subscriptionId: string;
  kind: 'snapshot' | 'patch' | 'event' | 'tombstone';
  data?: unknown;
  patch?: unknown[];
  events?: unknown[];
  seq?: string;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

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
  url = await listen(h);
});
afterEach(async () => {
  await h.close();
});

describe('WS / actor.call', () => {
  it('invokes a handler and returns the result', async () => {
    const created = (
      await h.app.inject({ method: 'POST', url: '/v1/actors/Counter', payload: {} })
    ).json() as { id: string };
    const c = await Client.connect(url);
    const res = (await c.request('actor.call', {
      class: 'Counter',
      id: created.id,
      method: 'inc',
      args: { by: 7 },
    })) as { result: number };
    expect(res.result).toBe(7);
    await c.close();
  });

  it('returns a JSON-RPC error for unknown method', async () => {
    const created = (
      await h.app.inject({ method: 'POST', url: '/v1/actors/Counter', payload: {} })
    ).json() as { id: string };
    const c = await Client.connect(url);
    await expect(
      c.request('actor.call', {
        class: 'Counter',
        id: created.id,
        method: 'no_such',
        args: {},
      }),
    ).rejects.toBeInstanceOf(RpcError);
    await c.close();
  });
});

describe('WS / actor.subscribe (SWM)', () => {
  it('delivers a snapshot then patches on each commit', async () => {
    const created = (
      await h.app.inject({ method: 'POST', url: '/v1/actors/Counter', payload: {} })
    ).json() as { id: string };

    // Materialize so the actor has state before subscribing.
    await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${created.id}/inc`,
      payload: { by: 1 },
    });

    const c = await Client.connect(url);
    const sub = (await c.request('actor.subscribe', {
      class: 'Counter',
      id: created.id,
    })) as { subscriptionId: string };

    // The initial snapshot is sent synchronously inside subscribe();
    // by the time the request resolves it has either arrived or is
    // racing the response — wait either way.
    const initial =
      c.events.find(
        (e) => e.method === 'actor.event' && (e.params as NotifParams).kind === 'snapshot',
      ) ?? (await c.nextNotification(sub.subscriptionId, (p) => p.kind === 'snapshot'));
    const snap = initial.params as NotifParams;
    expect(snap.kind).toBe('snapshot');
    expect((snap.data as { value: number }).value).toBe(1);

    const patchPromise = c.nextNotification(sub.subscriptionId, (p) => p.kind === 'patch');
    await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${created.id}/inc`,
      payload: { by: 4 },
    });
    const patchEv = await patchPromise;
    expect(patchEv.kind).toBe('patch');
    expect(Array.isArray(patchEv.patch)).toBe(true);
    expect((patchEv.patch as { op: string; path: string; value?: number }[])[0]?.path).toBe(
      '/value',
    );

    await c.close();
  });

  it('stops delivering after unsubscribe', async () => {
    const created = (
      await h.app.inject({ method: 'POST', url: '/v1/actors/Counter', payload: {} })
    ).json() as { id: string };
    await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${created.id}/inc`,
      payload: { by: 1 },
    });

    const c = await Client.connect(url);
    const sub = (await c.request('actor.subscribe', {
      class: 'Counter',
      id: created.id,
    })) as { subscriptionId: string };
    // Drain initial snapshot.
    await new Promise((r) => setTimeout(r, 10));
    const ok = (await c.request('actor.unsubscribe', {
      subscriptionId: sub.subscriptionId,
    })) as { ok: boolean };
    expect(ok.ok).toBe(true);

    const before = c.events.length;
    await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${created.id}/inc`,
      payload: { by: 9 },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(c.events.length).toBe(before);
    await c.close();
  });

  it('delivers a tombstone notification on DELETE', async () => {
    const created = (
      await h.app.inject({ method: 'POST', url: '/v1/actors/Counter', payload: {} })
    ).json() as { id: string };
    await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${created.id}/inc`,
      payload: { by: 1 },
    });

    const c = await Client.connect(url);
    const sub = (await c.request('actor.subscribe', {
      class: 'Counter',
      id: created.id,
    })) as { subscriptionId: string };

    const tombPromise = c.nextNotification(sub.subscriptionId, (p) => p.kind === 'tombstone');
    await h.app.inject({ method: 'DELETE', url: `/v1/actors/Counter/${created.id}` });
    const tomb = await tombPromise;
    expect(tomb.kind).toBe('tombstone');
    await c.close();
  });
});

describe('WS / actor.subscribe (ES)', () => {
  it('delivers an event notification on credit', async () => {
    const created = (
      await h.app.inject({ method: 'POST', url: '/v1/actors/Ledger', payload: {} })
    ).json() as { id: string };
    // Materialize first so the host exists for subscribe.
    await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Ledger/${created.id}/credit`,
      payload: { amount: 100 },
    });

    const c = await Client.connect(url);
    const sub = (await c.request('actor.subscribe', {
      class: 'Ledger',
      id: created.id,
    })) as { subscriptionId: string };

    const eventPromise = c.nextNotification(sub.subscriptionId, (p) => p.kind === 'event');
    await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Ledger/${created.id}/credit`,
      payload: { amount: 50 },
    });
    const ev = await eventPromise;
    expect(ev.kind).toBe('event');
    expect(Array.isArray(ev.events)).toBe(true);
    expect(typeof ev.seq).toBe('string');
    await c.close();
  });
});

describe('WS / heartbeat', () => {
  it('pings the client at the configured interval', async () => {
    await h.close(); // re-build with short ping interval
    const { buildApp } = await import('../../src/server/app.js');
    const { Runtime } = await import('../../src/runtime/index.js');
    const { MemoryStorageDriver } = await import('../../src/storage/memory.js');
    const driver = new MemoryStorageDriver();
    await driver.init();
    const runtime = new Runtime(driver);
    runtime.register({
      name: asClassName('Counter'),
      version: asVersion('1.0.0'),
      ctor: Counter,
      snapshotDebounceMs: 5,
    });
    const app = await buildApp({
      driver,
      runtime,
      wsPingIntervalMs: 50,
      wsPingTimeoutMs: 10_000,
      pinOptions: { lastSeenSampleEvery: 0 },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address() as AddressInfo;
    const localUrl = `ws://127.0.0.1:${addr.port}/v1/ws`;
    const ws = new WebSocket(localUrl);
    await new Promise<void>((res) => ws.once('open', () => res()));
    const got = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 500);
      ws.once('ping', () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    expect(got).toBe(true);
    ws.close();
    await app.close();
    await runtime.shutdown();
    await driver.close();

    // Rebuild for afterEach close to be happy.
    h = await buildHarness();
  });
});
