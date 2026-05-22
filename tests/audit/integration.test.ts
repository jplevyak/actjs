/**
 * Audit-integration tests: every privileged action emits the expected
 * audit entry. Uses the in-memory driver's `auditEntries()` helper to
 * read the log synchronously after each action.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Actor } from '../../src/actor.js';
import { handler } from '../../src/handler.js';
import { asClassName, asVersion } from '../../src/types/index.js';
import { ADMIN_HEADERS, buildHarness, VALID_SOURCE, type TestHarness } from '../server/harness.js';

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

function actionsByName(entries: ReadonlyArray<{ action: string }>): string[] {
  return entries.map((e) => e.action);
}

describe('audit emissions', () => {
  it('records class.published on POST /v1/classes/:name/versions', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/classes/Note/versions',
      headers: ADMIN_HEADERS,
      payload: { version: '1.0.0', source: VALID_SOURCE.replace(/Cart/g, 'Note') },
    });
    expect(res.statusCode).toBe(201);
    const actions = actionsByName(h.driver.auditEntries());
    expect(actions).toContain('class.published');
    const published = h.driver.auditEntries().find((e) => e.action === 'class.published')!;
    expect(published.target).toBe('Note@1.0.0');
    expect(published.principal).toBe('admin');
  });

  it('records class.deprecated on PATCH', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/v1/classes/Note/versions',
      headers: ADMIN_HEADERS,
      payload: { version: '1.0.0', source: VALID_SOURCE.replace(/Cart/g, 'Note') },
    });
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/v1/classes/Note/versions/1.0.0',
      headers: ADMIN_HEADERS,
      payload: { deprecated: true },
    });
    expect(res.statusCode).toBe(200);
    const deprecated = h.driver.auditEntries().find((e) => e.action === 'class.deprecated');
    expect(deprecated).toBeTruthy();
    expect(deprecated!.target).toBe('Note@1.0.0');
  });

  it('records actor.tombstoned on DELETE /v1/actors/:class/:id', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/actors/Counter',
      headers: ADMIN_HEADERS,
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };
    const incRes = await h.app.inject({
      method: 'POST',
      url: `/v1/actors/Counter/${id}/inc`,
      headers: ADMIN_HEADERS,
      payload: {},
    });
    expect(incRes.statusCode).toBe(200);
    const del = await h.app.inject({
      method: 'DELETE',
      url: `/v1/actors/Counter/${id}`,
      headers: { 'x-actjs-admin': '1' },
    });
    expect(del.statusCode).toBe(200);
    const tomb = h.driver.auditEntries().find((e) => e.action === 'actor.tombstoned');
    expect(tomb).toBeTruthy();
    expect(tomb!.target).toBe(`Counter:${id}`);
  });
});
