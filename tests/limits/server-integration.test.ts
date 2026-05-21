/**
 * End-to-end limit tests over the Fastify app: per-principal rate
 * limit returns 429 + Retry-After, per-class active-actor cap
 * returns 503 CapacityExhausted.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { Actor } from '../../src/actor.js';
import { handler } from '../../src/handler.js';
import { Runtime } from '../../src/runtime/index.js';
import { buildApp } from '../../src/server/app.js';
import { ManifestUsageTracker } from '../../src/server/manifest-tracker.js';
import { MemoryStorageDriver } from '../../src/storage/memory.js';
import { asClassName, asVersion } from '../../src/types/index.js';

import { defaultTestAuth } from '../server/harness.js';

class Counter extends Actor<{ n: number }> {
  override onInit(): void {
    this.state = { n: 0 };
  }
  @handler('inc')
  inc(): number {
    this.state.n++;
    return this.state.n;
  }
}

interface LimitHarness {
  driver: MemoryStorageDriver;
  runtime: Runtime;
  app: Awaited<ReturnType<typeof buildApp>>;
  close(): Promise<void>;
}

async function harness(
  options: {
    rateLimit?: { capacity: number; refillPerSec: number };
    activeCap?: number;
  } = {},
): Promise<LimitHarness> {
  const driver = new MemoryStorageDriver();
  await driver.init();
  const runtime = new Runtime(driver, {
    ...(options.rateLimit ? { rateLimiter: { default: options.rateLimit } } : {}),
    ...(options.activeCap !== undefined ? { activeActorCapPerClass: options.activeCap } : {}),
  });
  runtime.register({
    name: asClassName('Counter'),
    version: asVersion('1.0.0'),
    ctor: Counter,
  });
  const app = await buildApp({
    driver,
    runtime,
    tracker: new ManifestUsageTracker(),
    auth: defaultTestAuth,
    pinOptions: { lastSeenSampleEvery: 0 },
  });
  return {
    driver,
    runtime,
    app,
    close: async () => {
      await app.close();
      await runtime.shutdown();
      await driver.close();
    },
  };
}

describe('rate limit + caps over HTTP', () => {
  let h: LimitHarness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it('returns 429 + Retry-After when a principal busts its budget', async () => {
    h = await harness({ rateLimit: { capacity: 1, refillPerSec: 0 } });
    const create = await h.app.inject({
      method: 'POST',
      url: '/v1/actors/Counter',
      headers: { authorization: 'Bearer user-1', 'content-type': 'application/json' },
      payload: {},
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json() as { id: string };
    // First call consumes the only token.
    const first = await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${id}/inc`,
      headers: { authorization: 'Bearer user-1', 'content-type': 'application/json' },
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    const denied = await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${id}/inc`,
      headers: { authorization: 'Bearer user-1', 'content-type': 'application/json' },
      payload: {},
    });
    expect(denied.statusCode).toBe(429);
    expect(denied.headers['retry-after']).toBeTruthy();
    const body = denied.json() as { code: string; subject: string };
    expect(body.code).toBe('RateLimited');
    expect(body.subject).toBe('user-1');
  });

  it('returns 503 CapacityExhausted when the active-actor cap is hit', async () => {
    h = await harness({ activeCap: 2 });
    const ok1 = await h.app.inject({
      method: 'POST',
      url: '/v1/actors/Counter',
      headers: { 'x-actjs-admin': '1', 'content-type': 'application/json' },
      payload: {},
    });
    expect(ok1.statusCode).toBe(201);
    // Force materialization so the active count increments.
    const id1 = (ok1.json() as { id: string }).id;
    await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${id1}/inc`,
      headers: { 'x-actjs-admin': '1', 'content-type': 'application/json' },
      payload: {},
    });
    const ok2 = await h.app.inject({
      method: 'POST',
      url: '/v1/actors/Counter',
      headers: { 'x-actjs-admin': '1', 'content-type': 'application/json' },
      payload: {},
    });
    const id2 = (ok2.json() as { id: string }).id;
    await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${id2}/inc`,
      headers: { 'x-actjs-admin': '1', 'content-type': 'application/json' },
      payload: {},
    });
    // Third actor materialization should be refused.
    const ok3 = await h.app.inject({
      method: 'POST',
      url: '/v1/actors/Counter',
      headers: { 'x-actjs-admin': '1', 'content-type': 'application/json' },
      payload: {},
    });
    const id3 = (ok3.json() as { id: string }).id;
    const denied = await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${id3}/inc`,
      headers: { 'x-actjs-admin': '1', 'content-type': 'application/json' },
      payload: {},
    });
    expect(denied.statusCode).toBe(503);
    const body = denied.json() as { code: string; cap: number };
    expect(body.code).toBe('CapacityExhausted');
    expect(body.cap).toBe(2);
  });

  it('refilling lets the next request through after the wait', async () => {
    // capacity 1 + ~33 tokens/sec means after 30ms one token returns.
    h = await harness({ rateLimit: { capacity: 1, refillPerSec: 33 } });
    const create = await h.app.inject({
      method: 'POST',
      url: '/v1/actors/Counter',
      headers: { authorization: 'Bearer user-r', 'content-type': 'application/json' },
      payload: {},
    });
    const { id } = create.json() as { id: string };
    // First inc consumes the only token.
    const first = await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${id}/inc`,
      headers: { authorization: 'Bearer user-r', 'content-type': 'application/json' },
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    const denied = await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${id}/inc`,
      headers: { authorization: 'Bearer user-r', 'content-type': 'application/json' },
      payload: {},
    });
    expect(denied.statusCode).toBe(429);
    // Wait long enough to refill.
    await new Promise((r) => setTimeout(r, 80));
    const allowed = await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${id}/inc`,
      headers: { authorization: 'Bearer user-r', 'content-type': 'application/json' },
      payload: {},
    });
    expect(allowed.statusCode).toBe(200);
  });
});
