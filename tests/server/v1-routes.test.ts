/**
 * Round-trip tests against the Fastify app for /v1/classes,
 * /v1/manifest, and /v1/admin/manifests/in-use.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ADMIN_HEADERS, VALID_SOURCE, buildHarness, type TestHarness } from './harness.js';

let h: TestHarness;

beforeEach(async () => {
  h = await buildHarness();
});
afterEach(async () => {
  await h.close();
});

/* ----------------------------------------------------------- Health */

describe('GET /v1/health', () => {
  it('returns ok', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; uptimeMs: number };
    expect(body.status).toBe('ok');
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
  });
});

/* ----------------------------------------------------------- Publish */

describe('POST /v1/classes/:name/versions', () => {
  it('publishes a class version', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: ADMIN_HEADERS,
      payload: { version: '1.0.0', source: VALID_SOURCE },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { name: string; version: string; sha256: string };
    expect(body.name).toBe('Cart');
    expect(body.version).toBe('1.0.0');
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects without the admin header (403)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: { 'content-type': 'application/json' },
      payload: { version: '1.0.0', source: VALID_SOURCE },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    const body = res.json() as { code: string };
    expect(body.code).toBe('Forbidden');
  });

  it('returns 409 on duplicate publish', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: ADMIN_HEADERS,
      payload: { version: '1.0.0', source: VALID_SOURCE },
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: ADMIN_HEADERS,
      payload: { version: '1.0.0', source: VALID_SOURCE },
    });
    expect(res.statusCode).toBe(409);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
  });

  it('returns 400 with SyntaxInvalid on broken source', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: ADMIN_HEADERS,
      payload: { version: '1.0.0', source: 'class {' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('SyntaxInvalid');
  });

  it('returns 400 on schema-invalid body', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: ADMIN_HEADERS,
      payload: { source: 'whatever' /* missing version */ },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('SchemaInvalid');
  });
});

/* -------------------------------------------------------------- List */

describe('GET /v1/classes/:name/versions', () => {
  it('lists every published version', async () => {
    for (const v of ['1.0.0', '1.1.0', '1.2.0']) {
      await h.app.inject({
        method: 'POST',
        url: '/v1/classes/Cart/versions',
        headers: ADMIN_HEADERS,
        payload: { version: v, source: VALID_SOURCE },
      });
    }
    const res = await h.app.inject({ method: 'GET', url: '/v1/classes/Cart/versions' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { versions: Array<{ version: string }> };
    expect(body.versions.map((v) => v.version).sort()).toEqual(['1.0.0', '1.1.0', '1.2.0']);
  });
});

/* ---------------------------------------------------------- Deprecate */

describe('PATCH /v1/classes/:name/versions/:v', () => {
  it('flags a version deprecated', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: ADMIN_HEADERS,
      payload: { version: '1.0.0', source: VALID_SOURCE },
    });
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/v1/classes/Cart/versions/1.0.0',
      headers: ADMIN_HEADERS,
      payload: { deprecated: true },
    });
    expect(res.statusCode).toBe(200);
    const list = (
      (await h.app.inject({ method: 'GET', url: '/v1/classes/Cart/versions' })).json() as {
        versions: Array<{ deprecatedAt?: number }>;
      }
    ).versions;
    expect(list[0]?.deprecatedAt).toBeDefined();
  });
});

/* ---------------------------------------------------- Manifest resolve */

describe('GET /v1/manifest', () => {
  it('resolves a single root and stores the manifest', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: ADMIN_HEADERS,
      payload: {
        version: '1.4.2',
        source: VALID_SOURCE,
        deps: { Item: '^1.0.0' },
      },
    });
    await h.app.inject({
      method: 'POST',
      url: '/v1/classes/Item/versions',
      headers: ADMIN_HEADERS,
      payload: { version: '1.0.9', source: VALID_SOURCE },
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/manifest?root=${encodeURIComponent('Cart@1.4.2')}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sha256: string; resolved: Record<string, string> };
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.resolved).toEqual({ Cart: '1.4.2', Item: '1.0.9' });

    const loaded = await h.driver.loadManifest(body.sha256);
    expect(loaded).toEqual(body.resolved);
  });

  it('reports DepConflict (409)', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: ADMIN_HEADERS,
      payload: { version: '1.0.0', source: VALID_SOURCE, deps: { Item: '^1.0.0' } },
    });
    await h.app.inject({
      method: 'POST',
      url: '/v1/classes/Pricing/versions',
      headers: ADMIN_HEADERS,
      payload: { version: '1.0.0', source: VALID_SOURCE, deps: { Item: '^2.0.0' } },
    });
    for (const v of ['1.0.0', '2.0.0']) {
      await h.app.inject({
        method: 'POST',
        url: '/v1/classes/Item/versions',
        headers: ADMIN_HEADERS,
        payload: { version: v, source: VALID_SOURCE },
      });
    }
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/manifest?root=${encodeURIComponent(
        'Cart@1.0.0',
      )}&root=${encodeURIComponent('Pricing@1.0.0')}`,
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string; class: string };
    expect(body.code).toBe('DepConflict');
    expect(body.class).toBe('Item');
  });

  it('400 when no root/dep is supplied', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/manifest' });
    expect(res.statusCode).toBe(400);
  });
});

/* ----------------------------------------- Admin in-use endpoint */

describe('GET /v1/admin/manifests/in-use', () => {
  it('admin reads back the tracker', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: ADMIN_HEADERS,
      payload: { version: '1.0.0', source: VALID_SOURCE },
    });
    const sha = (
      (
        await h.app.inject({
          method: 'GET',
          url: `/v1/manifest?root=${encodeURIComponent('Cart@1.0.0')}`,
        })
      ).json() as { sha256: string }
    ).sha256;
    await h.app.inject({
      method: 'GET',
      url: `/v1/manifest/${sha}`,
      headers: { 'x-actjs-manifest': sha },
    });

    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/admin/manifests/in-use',
      headers: { 'x-actjs-admin': '1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: Array<{ sha: string; count: number }> };
    expect(body.entries.find((e) => e.sha === sha)?.count).toBeGreaterThanOrEqual(1);
  });

  it('rejects without the admin header (403)', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/admin/manifests/in-use',
    });
    expect(res.statusCode).toBe(403);
  });
});
