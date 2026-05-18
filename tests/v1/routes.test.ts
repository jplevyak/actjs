import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryStorageDriver } from '../../src/storage/memory.js';
import { registerV1Routes } from '../../src/v1/routes.js';

interface Harness {
  driver: MemoryStorageDriver;
  baseUrl: string;
  close: () => Promise<void>;
}

async function bootHarness(): Promise<Harness> {
  const driver = new MemoryStorageDriver();
  await driver.init();
  const app = express();
  registerV1Routes(app, driver);
  // Default error handler returns 500 for thrown errors. The route wrappers
  // already catch and map; this is a backstop.
  app.use(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ name: 'InternalError', message: msg });
    },
  );
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    driver,
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await driver.close();
    },
  };
}

const VALID_SOURCE = `
class Cart extends gact.Actor {
  constructor() { super(); }
}
return Cart;
`;

const ADMIN_HEADERS = {
  'content-type': 'application/json',
  'x-actjs-admin': '1',
};

/* ----------------------------------------------------------- Publish */

describe('POST /v1/classes/:name/versions', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await bootHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('publishes a valid class version and returns 201', async () => {
    const res = await fetch(`${h.baseUrl}/v1/classes/Cart/versions`, {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({
        version: '1.0.0',
        source: VALID_SOURCE,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; version: string; sha256: string };
    expect(body.name).toBe('Cart');
    expect(body.version).toBe('1.0.0');
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects without the admin header (403)', async () => {
    const res = await fetch(`${h.baseUrl}/v1/classes/Cart/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '1.0.0', source: VALID_SOURCE }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 409 on duplicate publish', async () => {
    await fetch(`${h.baseUrl}/v1/classes/Cart/versions`, {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ version: '1.0.0', source: VALID_SOURCE }),
    });
    const res = await fetch(`${h.baseUrl}/v1/classes/Cart/versions`, {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ version: '1.0.0', source: VALID_SOURCE }),
    });
    expect(res.status).toBe(409);
  });

  it('returns 400 on a non-semver version', async () => {
    const res = await fetch(`${h.baseUrl}/v1/classes/Cart/versions`, {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ version: 'not-a-version', source: VALID_SOURCE }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 on bad source syntax', async () => {
    const res = await fetch(`${h.baseUrl}/v1/classes/Cart/versions`, {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ version: '1.0.0', source: 'class {' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; diagnostics?: unknown };
    expect(body.code).toBe('SyntaxInvalid');
  });

  it('returns 400 on a bad class name in the URL', async () => {
    const res = await fetch(`${h.baseUrl}/v1/classes/bad-name!/versions`, {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ version: '1.0.0', source: VALID_SOURCE }),
    });
    expect(res.status).toBe(400);
  });
});

/* -------------------------------------------------------------- List */

describe('GET /v1/classes/:name/versions', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await bootHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('lists every published version of a class', async () => {
    for (const v of ['1.0.0', '1.1.0', '1.2.0']) {
      await fetch(`${h.baseUrl}/v1/classes/Cart/versions`, {
        method: 'POST',
        headers: ADMIN_HEADERS,
        body: JSON.stringify({ version: v, source: VALID_SOURCE }),
      });
    }
    const res = await fetch(`${h.baseUrl}/v1/classes/Cart/versions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      versions: Array<{ version: string }>;
    };
    expect(body.versions.map((v) => v.version).sort()).toEqual(['1.0.0', '1.1.0', '1.2.0']);
  });
});

/* -------------------------------------------------------- Deprecate */

describe('PATCH /v1/classes/:name/versions/:v', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await bootHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('flags a version deprecated', async () => {
    await fetch(`${h.baseUrl}/v1/classes/Cart/versions`, {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ version: '1.0.0', source: VALID_SOURCE }),
    });
    const res = await fetch(`${h.baseUrl}/v1/classes/Cart/versions/1.0.0`, {
      method: 'PATCH',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ deprecated: true }),
    });
    expect(res.status).toBe(200);
    const list = (await (await fetch(`${h.baseUrl}/v1/classes/Cart/versions`)).json()) as {
      versions: Array<{ version: string; deprecatedAt?: number }>;
    };
    expect(list.versions[0]?.deprecatedAt).toBeDefined();
  });
});

/* -------------------------------------------------------- Manifest */

describe('GET /v1/manifest', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await bootHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('resolves a single-root tree and saves the manifest', async () => {
    await fetch(`${h.baseUrl}/v1/classes/Cart/versions`, {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({
        version: '1.4.2',
        source: VALID_SOURCE,
        deps: { Item: '^1.0.0' },
      }),
    });
    await fetch(`${h.baseUrl}/v1/classes/Item/versions`, {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ version: '1.0.0', source: VALID_SOURCE }),
    });
    await fetch(`${h.baseUrl}/v1/classes/Item/versions`, {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ version: '1.0.9', source: VALID_SOURCE }),
    });

    const res = await fetch(`${h.baseUrl}/v1/manifest?root=${encodeURIComponent('Cart@1.4.2')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sha256: string;
      resolved: Record<string, string>;
    };
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.resolved).toEqual({ Cart: '1.4.2', Item: '1.0.9' });

    // Manifest is saved in the driver for later cache lookups.
    const loaded = await h.driver.loadManifest(body.sha256);
    expect(loaded).toEqual(body.resolved);
  });

  it('reports DepConflict with the cause path', async () => {
    await fetch(`${h.baseUrl}/v1/classes/Cart/versions`, {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({
        version: '1.0.0',
        source: VALID_SOURCE,
        deps: { Item: '^1.0.0' },
      }),
    });
    await fetch(`${h.baseUrl}/v1/classes/Pricing/versions`, {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({
        version: '1.0.0',
        source: VALID_SOURCE,
        deps: { Item: '^2.0.0' },
      }),
    });
    await fetch(`${h.baseUrl}/v1/classes/Item/versions`, {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ version: '1.0.0', source: VALID_SOURCE }),
    });
    await fetch(`${h.baseUrl}/v1/classes/Item/versions`, {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ version: '2.0.0', source: VALID_SOURCE }),
    });

    const res = await fetch(
      `${h.baseUrl}/v1/manifest?root=${encodeURIComponent(
        'Cart@1.0.0',
      )}&root=${encodeURIComponent('Pricing@1.0.0')}`,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; class: string };
    expect(body.code).toBe('DepConflict');
    expect(body.class).toBe('Item');
  });

  it('rejects when no root/dep is provided', async () => {
    const res = await fetch(`${h.baseUrl}/v1/manifest`);
    expect(res.status).toBe(400);
  });

  it('rejects malformed root specs', async () => {
    const res = await fetch(`${h.baseUrl}/v1/manifest?root=NoAtSign`);
    expect(res.status).toBe(400);
  });
});

/* ----------------------------------------------------------- Class index stub */

describe('GET /v1/classes', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await bootHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns 501 (NotImplemented) — class index lands in Phase 4.2', async () => {
    const res = await fetch(`${h.baseUrl}/v1/classes`);
    expect(res.status).toBe(501);
  });
});
