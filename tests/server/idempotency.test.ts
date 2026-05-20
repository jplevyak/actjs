/**
 * Idempotency-Key replay behavior.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Actor } from '../../src/actor.js';
import { handler } from '../../src/handler.js';
import { asClassName, asVersion } from '../../src/types/index.js';

import { ADMIN_HEADERS, VALID_SOURCE, buildHarness, type TestHarness } from './harness.js';

let h: TestHarness;
beforeEach(async () => {
  h = await buildHarness();
});
afterEach(async () => {
  await h.close();
});

describe('Idempotency-Key replay', () => {
  it('publishing twice with the same key returns the same response and writes once', async () => {
    const key = 'idem-publish-1';

    const first = await h.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: { ...ADMIN_HEADERS, 'idempotency-key': key },
      payload: { version: '1.0.0', source: VALID_SOURCE },
    });
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotency-key']).toBe(key);

    // Same body. The second one would be a 409 (duplicate publish)
    // if it ran fresh — but the idempotency hook replays the stored
    // 201 instead.
    const second = await h.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: { ...ADMIN_HEADERS, 'idempotency-key': key },
      payload: { version: '1.0.0', source: VALID_SOURCE },
    });
    expect(second.statusCode).toBe(201);
    expect(second.body).toBe(first.body);
    expect(second.headers['idempotency-replayed']).toBe('true');

    // Listing confirms only one version exists.
    const list = await h.app.inject({ method: 'GET', url: '/v1/classes/Cart/versions' });
    const body = list.json() as { versions: Array<{ version: string }> };
    expect(body.versions).toHaveLength(1);
  });

  it('idempotency is not applied on GETs', async () => {
    const key = 'idem-get';
    await h.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: { ...ADMIN_HEADERS, 'idempotency-key': key },
      payload: { version: '1.0.0', source: VALID_SOURCE },
    });
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/classes/Cart/versions',
      headers: { 'idempotency-key': key },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['idempotency-replayed']).toBeUndefined();
  });

  it('idempotent actor call replays the original result', async () => {
    class Counter extends Actor<{ value: number }> {
      override onInit(): void {
        this.state = { value: 0 };
      }
      @handler('increment')
      increment(args: { by: number }): number {
        this.state.value += args.by;
        return this.state.value;
      }
    }
    h.runtime.register({
      name: asClassName('Counter'),
      version: asVersion('1.0.0'),
      ctor: Counter,
      snapshotDebounceMs: 2,
    });
    const id = (
      (await h.app.inject({ method: 'POST', url: '/v1/actors/Counter', payload: {} })).json() as {
        id: string;
      }
    ).id;

    const key = 'idem-call';
    const r1 = await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${id}/increment`,
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      payload: { by: 5 },
    });
    expect((r1.json() as { result: number }).result).toBe(5);

    const r2 = await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${id}/increment`,
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      payload: { by: 5 },
    });
    // Replayed: the handler did NOT run a second time.
    expect((r2.json() as { result: number }).result).toBe(5);
    expect(r2.headers['idempotency-replayed']).toBe('true');
  });
});
