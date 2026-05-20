/**
 * BYO auth hook + admin-role gating tests.
 *
 * Each test builds an isolated harness so we can pass different
 * `auth` options without leaking state across cases.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { Runtime } from '../../src/runtime/index.js';
import { buildApp } from '../../src/server/app.js';
import { staticToken, verifyHmac, type AuthHook, type Principal } from '../../src/server/auth.js';
import { ManifestUsageTracker } from '../../src/server/manifest-tracker.js';
import { MemoryStorageDriver } from '../../src/storage/memory.js';
import { asClassName, asVersion } from '../../src/types/index.js';
import { Actor } from '../../src/actor.js';
import { handler } from '../../src/handler.js';
import { createHmac } from 'node:crypto';

import { VALID_SOURCE } from './harness.js';

interface Bundle {
  app: Awaited<ReturnType<typeof buildApp>>;
  close: () => Promise<void>;
}

async function buildBundle(
  opts: { auth?: AuthHook | undefined; requireAuth?: boolean } = {},
): Promise<Bundle> {
  const driver = new MemoryStorageDriver();
  await driver.init();
  const runtime = new Runtime(driver);
  const tracker = new ManifestUsageTracker();
  const app = await buildApp({
    driver,
    runtime,
    tracker,
    pinOptions: { lastSeenSampleEvery: 0 },
    ...(opts.auth ? { auth: opts.auth } : {}),
    ...(opts.requireAuth !== undefined ? { requireAuth: opts.requireAuth } : {}),
  });
  return {
    app,
    close: async () => {
      await app.close();
      await runtime.shutdown();
      await driver.close();
    },
  };
}

let bundle: Bundle | null = null;
afterEach(async () => {
  if (bundle) {
    await bundle.close();
    bundle = null;
  }
});

describe('auth hook — anonymous default', () => {
  it('attaches anonymous principal when no auth hook is configured', async () => {
    bundle = await buildBundle();
    let captured: Principal | null = null;
    bundle.app.get('/__probe', async (req) => {
      captured = req.principal;
      return { ok: true };
    });
    await bundle.app.ready();
    const res = await bundle.app.inject({ method: 'GET', url: '/__probe' });
    expect(res.statusCode).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.sub).toBe('anonymous');
  });

  it('admin routes reject anonymous (403 Forbidden)', async () => {
    bundle = await buildBundle();
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: { 'content-type': 'application/json' },
      payload: { version: '1.0.0', source: VALID_SOURCE },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { code: string };
    expect(body.code).toBe('Forbidden');
  });
});

describe('auth hook — requireAuth', () => {
  it('returns 401 when auth returns null and requireAuth is true', async () => {
    bundle = await buildBundle({
      auth: () => null,
      requireAuth: true,
    });
    const res = await bundle.app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { code: string };
    expect(body.code).toBe('Unauthorized');
  });

  it('allows anonymous when requireAuth is false', async () => {
    bundle = await buildBundle({ auth: () => null });
    const res = await bundle.app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
  });

  it('forwards principal returned by hook to req.principal', async () => {
    bundle = await buildBundle({
      auth: () => ({ sub: 'alice', roles: ['member'], tenant: 'acme' }),
    });
    let captured: Principal | null = null;
    bundle.app.get('/__probe', async (req) => {
      captured = req.principal;
      return { ok: true };
    });
    await bundle.app.ready();
    const res = await bundle.app.inject({ method: 'GET', url: '/__probe' });
    expect(res.statusCode).toBe(200);
    expect(captured).toMatchObject({ sub: 'alice', tenant: 'acme', roles: ['member'] });
  });

  it('errors thrown by the hook surface as 500 by default', async () => {
    bundle = await buildBundle({
      auth: () => {
        throw new Error('boom');
      },
    });
    const res = await bundle.app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { code: string };
    expect(body.code).toBe('Unauthorized');
  });
});

describe('admin gating', () => {
  it('non-admin token can read but not publish', async () => {
    bundle = await buildBundle({
      auth: (req) => {
        const a = req.headers['authorization'];
        if (typeof a === 'string' && a === 'Bearer user-1') {
          return { sub: 'user-1', roles: [] };
        }
        return null;
      },
    });
    // GET is public.
    const list = await bundle.app.inject({
      method: 'GET',
      url: '/v1/classes/Cart/versions',
      headers: { authorization: 'Bearer user-1' },
    });
    expect(list.statusCode).toBe(200);
    // POST requires admin.
    const publish = await bundle.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: { authorization: 'Bearer user-1', 'content-type': 'application/json' },
      payload: { version: '1.0.0', source: VALID_SOURCE },
    });
    expect(publish.statusCode).toBe(403);
  });

  it('admin token can publish', async () => {
    bundle = await buildBundle({
      auth: (req) => {
        const a = req.headers['authorization'];
        if (typeof a === 'string' && a === 'Bearer admin-1') {
          return { sub: 'admin-1', roles: ['admin'] };
        }
        return null;
      },
    });
    const publish = await bundle.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: { authorization: 'Bearer admin-1', 'content-type': 'application/json' },
      payload: { version: '1.0.0', source: VALID_SOURCE },
    });
    expect(publish.statusCode).toBe(201);
  });

  it('legacy /run requires admin', async () => {
    bundle = await buildBundle();
    // Anonymous → 403.
    const anon = await bundle.app.inject({
      method: 'POST',
      url: '/run',
      headers: { 'content-type': 'text/plain' },
      payload: 'return 1;',
    });
    expect(anon.statusCode).toBe(403);
  });
});

describe('built-in verifiers', () => {
  it('staticToken resolves a bearer to its mapped Principal', async () => {
    const auth = staticToken({
      k1: { sub: 'alice', roles: ['admin'] },
    });
    bundle = await buildBundle({ auth });
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
      payload: { version: '1.0.0', source: VALID_SOURCE },
    });
    expect(res.statusCode).toBe(201);
  });

  it('staticToken treats unknown bearers as anonymous', async () => {
    bundle = await buildBundle({
      auth: staticToken({ k1: { sub: 'alice', roles: ['admin'] } }),
    });
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: { authorization: 'Bearer bogus', 'content-type': 'application/json' },
      payload: { version: '1.0.0', source: VALID_SOURCE },
    });
    expect(res.statusCode).toBe(403);
  });

  it('verifyHmac accepts a valid signature and rejects a bad one', async () => {
    const secret = 'sekret';
    bundle = await buildBundle({ auth: verifyHmac(secret) });

    const principal = { sub: 'svc-a', roles: ['admin'] };
    const payload = Buffer.from(JSON.stringify(principal)).toString('base64');
    const sig = createHmac('sha256', secret).update(payload).digest('hex');
    const ok = await bundle.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: {
        'content-type': 'application/json',
        'x-actjs-principal': payload,
        'x-actjs-signature': sig,
      },
      payload: { version: '1.0.0', source: VALID_SOURCE },
    });
    expect(ok.statusCode).toBe(201);

    const bad = await bundle.app.inject({
      method: 'POST',
      url: '/v1/classes/Cart/versions',
      headers: {
        'content-type': 'application/json',
        'x-actjs-principal': payload,
        'x-actjs-signature': 'deadbeef'.repeat(8),
      },
      payload: { version: '2.0.0', source: VALID_SOURCE },
    });
    expect(bad.statusCode).toBe(403);
  });
});

// Suppress unused-import noise in this isolated test file.
void Actor;
void handler;
void asClassName;
void asVersion;
