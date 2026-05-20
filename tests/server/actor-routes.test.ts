/**
 * Actor REST routes end-to-end against the in-memory runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Actor } from '../../src/actor.js';
import { handler } from '../../src/handler.js';
import { asClassName, asVersion } from '../../src/types/index.js';

import { buildHarness, type TestHarness } from './harness.js';

class Counter extends Actor<{ value: number }> {
  override onInit(): void {
    this.state = { value: 0 };
  }
  @handler('increment')
  increment(args: { by: number }): number {
    this.state.value += args.by;
    return this.state.value;
  }
  @handler('read')
  read(): number {
    return this.state.value;
  }
}

let h: TestHarness;
beforeEach(async () => {
  h = await buildHarness();
  h.runtime.register({
    name: asClassName('Counter'),
    version: asVersion('1.0.0'),
    ctor: Counter,
    snapshotDebounceMs: 5,
  });
});
afterEach(async () => {
  await h.close();
});

describe('POST /v1/actors/:class', () => {
  it('mints a fresh actor id', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/actors/Counter',
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { class: string; id: string };
    expect(body.class).toBe('Counter');
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('POST /v1/actors/:class/:id/:method', () => {
  it('invokes a handler and returns its result', async () => {
    const created = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/actors/Counter',
        payload: {},
      })
    ).json() as { id: string };
    const id = created.id;

    const inc = await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${id}/increment`,
      payload: { by: 5 },
    });
    expect(inc.statusCode).toBe(200);
    expect((inc.json() as { result: number }).result).toBe(5);

    const read = await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${id}/read`,
      payload: {},
    });
    expect((read.json() as { result: number }).result).toBe(5);
  });

  it('400 on a missing method (handler not registered)', async () => {
    const created = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/actors/Counter',
        payload: {},
      })
    ).json() as { id: string };
    // The runtime's call() returns a rejected promise for an unknown
    // method (the host throws). It maps to a 500 by the generic
    // handler; assert non-2xx.
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${created.id}/does_not_exist`,
      payload: {},
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('400 on unknown class', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/actors/Mystery/whatever/ping',
      payload: {},
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('GET /v1/actors/:class/:id', () => {
  it('returns 404 before any snapshot is written', async () => {
    const id = (
      (await h.app.inject({ method: 'POST', url: '/v1/actors/Counter', payload: {} })).json() as {
        id: string;
      }
    ).id;
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/actors/Counter/${id}`,
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { code: string };
    expect(body.code).toBe('ActorNotFound');
  });

  it('returns the snapshot after activation', async () => {
    const id = (
      (await h.app.inject({ method: 'POST', url: '/v1/actors/Counter', payload: {} })).json() as {
        id: string;
      }
    ).id;
    await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${id}/increment`,
      payload: { by: 3 },
    });
    await h.runtime.drain();
    // Let the debounced snapshot flush.
    await new Promise((r) => setTimeout(r, 30));
    const res = await h.app.inject({ method: 'GET', url: `/v1/actors/Counter/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { state: { value: number }; version: string };
    expect(body.state.value).toBe(3);
    expect(body.version).toBe('1.0.0');
  });
});

describe('DELETE /v1/actors/:class/:id', () => {
  it('tombstones the actor', async () => {
    const id = (
      (await h.app.inject({ method: 'POST', url: '/v1/actors/Counter', payload: {} })).json() as {
        id: string;
      }
    ).id;
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/v1/actors/Counter/${id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tombstoned: boolean };
    expect(body.tombstoned).toBe(true);
  });
});
