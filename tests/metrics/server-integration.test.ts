/**
 * /metrics endpoint + cross-cutting counter wiring through buildApp.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Actor } from '../../src/actor.js';
import { handler } from '../../src/handler.js';
import { MetricsRegistry } from '../../src/metrics/index.js';
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

interface Built {
  driver: MemoryStorageDriver;
  runtime: Runtime;
  metrics: MetricsRegistry;
  app: Awaited<ReturnType<typeof buildApp>>;
  close(): Promise<void>;
}

async function build(): Promise<Built> {
  const driver = new MemoryStorageDriver();
  await driver.init();
  const metrics = new MetricsRegistry({ collectDefault: false });
  const runtime = new Runtime(driver, { metrics });
  runtime.register({
    name: asClassName('Counter'),
    version: asVersion('1.0.0'),
    ctor: Counter,
  });
  const app = await buildApp({
    driver,
    runtime,
    tracker: new ManifestUsageTracker({ metrics }),
    auth: defaultTestAuth,
    pinOptions: { lastSeenSampleEvery: 0 },
  });
  return {
    driver,
    runtime,
    metrics,
    app,
    close: async () => {
      await app.close();
      await runtime.shutdown();
      await driver.close();
    },
  };
}

let h: Built;
beforeEach(async () => {
  h = await build();
});
afterEach(async () => {
  await h.close();
});

describe('GET /metrics', () => {
  it('exposes prometheus text after a few actor calls', async () => {
    const create = await h.app.inject({
      method: 'POST',
      url: '/v1/actors/Counter',
      headers: { 'x-actjs-admin': '1', 'content-type': 'application/json' },
      payload: {},
    });
    const { id } = create.json() as { id: string };
    for (let i = 0; i < 3; i++) {
      const res = await h.app.inject({
        method: 'POST',
        url: `/v1/actors/Counter/${id}/inc`,
        headers: { 'x-actjs-admin': '1', 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    }
    const m = await h.app.inject({ method: 'GET', url: '/metrics' });
    expect(m.statusCode).toBe(200);
    expect(m.headers['content-type']).toContain('text/plain');
    expect(m.body).toContain(
      'actjs_actor_message_total{class="Counter",method="inc",outcome="ok"} 3',
    );
    expect(m.body).toContain('actjs_actor_active{class="Counter",version="1.0.0"} 1');
  });

  it('records policy_decision and rate_limit_drop when those branches fire', async () => {
    // Rebuild with a tight rate limiter.
    await h.close();
    const driver = new MemoryStorageDriver();
    await driver.init();
    const metrics = new MetricsRegistry({ collectDefault: false });
    const runtime = new Runtime(driver, {
      metrics,
      rateLimiter: { default: { capacity: 1, refillPerSec: 0 } },
    });
    runtime.register({
      name: asClassName('Counter'),
      version: asVersion('1.0.0'),
      ctor: Counter,
    });
    const app = await buildApp({
      driver,
      runtime,
      tracker: new ManifestUsageTracker({ metrics }),
      auth: defaultTestAuth,
      pinOptions: { lastSeenSampleEvery: 0 },
    });
    h = {
      driver,
      runtime,
      metrics,
      app,
      close: async () => {
        await app.close();
        await runtime.shutdown();
        await driver.close();
      },
    };
    const create = await app.inject({
      method: 'POST',
      url: '/v1/actors/Counter',
      headers: { authorization: 'Bearer ratelimit-user', 'content-type': 'application/json' },
      payload: {},
    });
    const { id } = create.json() as { id: string };
    await app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${id}/inc`,
      headers: { authorization: 'Bearer ratelimit-user', 'content-type': 'application/json' },
      payload: {},
    });
    const denied = await app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${id}/inc`,
      headers: { authorization: 'Bearer ratelimit-user', 'content-type': 'application/json' },
      payload: {},
    });
    expect(denied.statusCode).toBe(429);
    const m = await app.inject({ method: 'GET', url: '/metrics' });
    expect(m.body).toContain('actjs_rate_limit_drop_total{subject="ratelimit-user"} 1');
    expect(m.body).toContain(
      'actjs_actor_message_total{class="Counter",method="inc",outcome="rate_limited"} 1',
    );
  });
});

describe('cardinality guard end-to-end', () => {
  it('a flood of distinct methods caps at methodLimit + 1 distinct rows', async () => {
    // Smaller cap to exercise the guard with fewer requests.
    await h.close();
    const driver = new MemoryStorageDriver();
    await driver.init();
    const metrics = new MetricsRegistry({ collectDefault: false, methodLimit: 5 });
    const runtime = new Runtime(driver, { metrics });
    runtime.register({
      name: asClassName('Counter'),
      version: asVersion('1.0.0'),
      ctor: Counter,
    });
    const app = await buildApp({
      driver,
      runtime,
      tracker: new ManifestUsageTracker({ metrics }),
      auth: defaultTestAuth,
      pinOptions: { lastSeenSampleEvery: 0 },
    });
    h = {
      driver,
      runtime,
      metrics,
      app,
      close: async () => {
        await app.close();
        await runtime.shutdown();
        await driver.close();
      },
    };
    const create = await app.inject({
      method: 'POST',
      url: '/v1/actors/Counter',
      headers: { 'x-actjs-admin': '1', 'content-type': 'application/json' },
      payload: {},
    });
    const { id } = create.json() as { id: string };
    for (let i = 0; i < 20; i++) {
      // The actor only has @handler('inc'); calls to other methods
      // produce `outcome="error"` rows. That's fine — we're testing
      // the *method-label* cardinality bucket, not the outcome.
      await app.inject({
        method: 'POST',
        url: `/v1/actors/Counter/${id}/m${i}`,
        headers: { 'x-actjs-admin': '1', 'content-type': 'application/json' },
        payload: {},
      });
    }
    const m = await app.inject({ method: 'GET', url: '/metrics' });
    const methodLabelHits = (
      m.body.match(/actjs_actor_message_total\{class="Counter",method="/g) ?? []
    ).length;
    // 5 distinct kept + 1 "_other" bucket = 6 distinct rows.
    expect(methodLabelHits).toBeLessThanOrEqual(6);
    expect(m.body).toContain('method="_other"');
  });
});
