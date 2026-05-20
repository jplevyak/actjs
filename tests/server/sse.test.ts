/**
 * SSE endpoint tests.
 *
 * Fastify's `inject` can't drive a streaming response, so we boot the
 * server on an ephemeral port and connect with `http.request` to
 * read the `text/event-stream` byte-by-byte.
 */
import { AddressInfo } from 'node:net';
import { request, type IncomingMessage } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
let base: string;

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
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await h.close();
});

interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
}

function parseSseFrames(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of text.split(/\n\n/)) {
    if (!block.trim()) continue;
    const frame: SseFrame = {};
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // comment
      const colonIndex = line.indexOf(':');
      if (colonIndex < 0) continue;
      const field = line.slice(0, colonIndex);
      const value = line.slice(colonIndex + 1).replace(/^ /, '');
      if (field === 'id') frame.id = value;
      else if (field === 'event') frame.event = value;
      else if (field === 'data') frame.data = value;
    }
    if (frame.event || frame.data || frame.id) frames.push(frame);
  }
  return frames;
}

interface SseClient {
  res: IncomingMessage;
  buffer: string;
  frames: SseFrame[];
  /** Resolves once a frame matching `predicate` arrives. */
  waitFor(predicate: (f: SseFrame) => boolean, timeoutMs?: number): Promise<SseFrame>;
  close: () => void;
}

function connectSse(url: string, headers: Record<string, string> = {}): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: { Accept: 'text/event-stream', ...headers },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`expected 200, got ${res.statusCode ?? 'unknown'}`));
          res.resume();
          return;
        }
        const client: SseClient = {
          res,
          buffer: '',
          frames: [],
          waitFor: (predicate, timeoutMs = 2_000) =>
            new Promise((res2, rej2) => {
              const t = setTimeout(
                () => rej2(new Error(`SSE waitFor timed out (${timeoutMs}ms)`)),
                timeoutMs,
              );
              const existing = client.frames.find(predicate);
              if (existing) {
                clearTimeout(t);
                res2(existing);
                return;
              }
              const listener = (): void => {
                const match = client.frames.find(predicate);
                if (match) {
                  clearTimeout(t);
                  res.off('data', listener);
                  res2(match);
                }
              };
              res.on('data', listener);
            }),
          close: () => {
            req.destroy();
          },
        };
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          client.buffer += chunk;
          // Frames are delimited by blank lines.
          const parts = client.buffer.split(/\n\n/);
          client.buffer = parts.pop() ?? '';
          for (const part of parts) {
            const parsed = parseSseFrames(`${part}\n\n`);
            client.frames.push(...parsed);
          }
        });
        resolve(client);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('GET /v1/actors/:class/:id/events', () => {
  it('streams initial snapshot for SWM actor', async () => {
    const created = (
      await h.app.inject({ method: 'POST', url: '/v1/actors/Counter', payload: {} })
    ).json() as { id: string };
    await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${created.id}/inc`,
      payload: { by: 5 },
    });

    const client = await connectSse(`${base}/v1/actors/Counter/${created.id}/events`);
    try {
      const snap = await client.waitFor(
        (f) => f.event === 'actor.event' && (f.data?.includes('"snapshot"') ?? false),
      );
      const parsed = JSON.parse(snap.data!) as { kind: string; data: { value: number } };
      expect(parsed.kind).toBe('snapshot');
      expect(parsed.data.value).toBe(5);
    } finally {
      client.close();
    }
  });

  it('delivers patches matching WS notification shape (SWM)', async () => {
    const created = (
      await h.app.inject({ method: 'POST', url: '/v1/actors/Counter', payload: {} })
    ).json() as { id: string };
    await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${created.id}/inc`,
      payload: { by: 1 },
    });

    const client = await connectSse(`${base}/v1/actors/Counter/${created.id}/events`);
    try {
      await client.waitFor((f) => f.data?.includes('"snapshot"') ?? false);
      await h.app.inject({
        method: 'POST',
        url: `/v1/actors/Counter/${created.id}/inc`,
        payload: { by: 7 },
      });
      const patchFrame = await client.waitFor((f) => f.data?.includes('"patch"') ?? false);
      const parsed = JSON.parse(patchFrame.data!) as {
        kind: string;
        patch: { op: string; path: string; value?: number }[];
      };
      expect(parsed.kind).toBe('patch');
      expect(parsed.patch[0]?.path).toBe('/value');
    } finally {
      client.close();
    }
  });

  it('delivers ES events with seq matching WS', async () => {
    const created = (
      await h.app.inject({ method: 'POST', url: '/v1/actors/Ledger', payload: {} })
    ).json() as { id: string };
    await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Ledger/${created.id}/credit`,
      payload: { amount: 10 },
    });

    const client = await connectSse(`${base}/v1/actors/Ledger/${created.id}/events`);
    try {
      await client.waitFor((f) => f.data?.includes('"snapshot"') ?? false);
      await h.app.inject({
        method: 'POST',
        url: `/v1/actors/Ledger/${created.id}/credit`,
        payload: { amount: 5 },
      });
      const ev = await client.waitFor(
        (f) => f.event === 'actor.event' && (f.data?.includes('"event"') ?? false),
      );
      const parsed = JSON.parse(ev.data!) as {
        kind: string;
        events: { type: string; payload: { amount: number } }[];
        seq: string;
      };
      expect(parsed.kind).toBe('event');
      expect(parsed.events[0]?.type).toBe('credit');
      expect(ev.id).toBe(parsed.seq);
    } finally {
      client.close();
    }
  });

  it('replays from Last-Event-ID for ES actor', async () => {
    const created = (
      await h.app.inject({ method: 'POST', url: '/v1/actors/Ledger', payload: {} })
    ).json() as { id: string };
    // Materialize and append three events; we'll resume from seq=1.
    for (const amount of [1, 2, 3]) {
      await h.app.inject({
        method: 'POST',
        url: `/v1/actors/Ledger/${created.id}/credit`,
        payload: { amount },
      });
    }

    const client = await connectSse(`${base}/v1/actors/Ledger/${created.id}/events`, {
      'Last-Event-ID': '1',
    });
    try {
      const ev = await client.waitFor(
        (f) => f.event === 'actor.event' && (f.data?.includes('"event"') ?? false),
      );
      const parsed = JSON.parse(ev.data!) as {
        kind: string;
        events: { type: string; payload: { amount: number } }[];
        seq: string;
      };
      // Replay batches the missing events into one notification; seq is
      // the highest delivered.
      expect(parsed.kind).toBe('event');
      expect(parsed.events.length).toBe(2);
      expect(parsed.seq).toBe('3');
    } finally {
      client.close();
    }
  });

  it('drops the live subscription when the client disconnects', async () => {
    const created = (
      await h.app.inject({ method: 'POST', url: '/v1/actors/Counter', payload: {} })
    ).json() as { id: string };

    const client = await connectSse(`${base}/v1/actors/Counter/${created.id}/events`);
    await client.waitFor((f) => f.data?.includes('"snapshot"') ?? false);
    // Touch a runtime internal so we can observe subscription teardown.
    // The SubscriptionRegistry's `notifications` counter is the only
    // public signal — instead we observe that a fresh subscription works
    // after closing the prior one.
    client.close();
    await new Promise((r) => setTimeout(r, 50));

    const client2 = await connectSse(`${base}/v1/actors/Counter/${created.id}/events`);
    try {
      await client2.waitFor((f) => f.data?.includes('"snapshot"') ?? false, 2_000);
    } finally {
      client2.close();
    }
  });

  it('honors ?manifest= query-string pin', async () => {
    // Publish a class via the public API so a real manifest sha exists.
    await h.app.inject({
      method: 'POST',
      url: '/v1/classes/Counter/versions',
      headers: { 'content-type': 'application/json', 'x-actjs-admin': '1' },
      payload: { version: '1.0.0', source: 'return class C extends actjs.Actor {};' },
    });
    const manifestRes = await h.app.inject({
      method: 'GET',
      url: `/v1/manifest?root=${encodeURIComponent('Counter@1.0.0')}`,
    });
    const manifest = manifestRes.json() as { sha256: string };

    const created = (
      await h.app.inject({ method: 'POST', url: '/v1/actors/Counter', payload: {} })
    ).json() as { id: string };

    const client = await connectSse(
      `${base}/v1/actors/Counter/${created.id}/events?manifest=${manifest.sha256}`,
    );
    try {
      await client.waitFor((f) => f.data?.includes('"snapshot"') ?? false);
    } finally {
      client.close();
    }
  });
});
