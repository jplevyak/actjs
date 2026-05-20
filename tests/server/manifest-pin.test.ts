/**
 * Manifest pin behavior on the Fastify app.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { asClassName, asVersion } from '../../src/types/index.js';

import { ADMIN_HEADERS, VALID_SOURCE, buildHarness, type TestHarness } from './harness.js';

let h: TestHarness;
beforeEach(async () => {
  h = await buildHarness();
});
afterEach(async () => {
  await h.close();
});

async function publishCart(version: string): Promise<void> {
  await h.app.inject({
    method: 'POST',
    url: '/v1/classes/Cart/versions',
    headers: ADMIN_HEADERS,
    payload: { version, source: VALID_SOURCE },
  });
}

async function resolveShaForCart(version: string): Promise<string> {
  const res = await h.app.inject({
    method: 'GET',
    url: `/v1/manifest?root=${encodeURIComponent(`Cart@${version}`)}`,
  });
  return (res.json() as { sha256: string }).sha256;
}

describe('Pin — happy path', () => {
  it('records the pin and the request proceeds', async () => {
    await publishCart('1.0.0');
    const sha = await resolveShaForCart('1.0.0');

    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/manifest/${sha}`,
      headers: { 'x-actjs-manifest': sha },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['warning']).toBeUndefined();
    const tracked = h.tracker.report().entries.map((e) => e.sha);
    expect(tracked).toContain(sha);
  });

  it('rejects an unknown sha with 400 ManifestUnknown', async () => {
    const fake = 'a'.repeat(64);
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/classes/Cart/versions',
      headers: { 'x-actjs-manifest': fake },
    });
    // The pin middleware throws StatusError(400). The error handler
    // surfaces a problem-detail. (The exception's `name` is the literal
    // class name, "StatusError", because the pin middleware throws a
    // generic StatusError; we just assert the status code here.)
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
  });
});

describe('Pin — deprecation lifecycle', () => {
  it('deprecated-but-in-grace emits Warning 299, request succeeds', async () => {
    await publishCart('1.0.0');
    const sha = await resolveShaForCart('1.0.0');

    await h.driver.deprecateClassVersion(
      asClassName('Cart'),
      asVersion('1.0.0'),
      Date.now() + 3_600_000,
    );

    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/manifest/${sha}`,
      headers: { 'x-actjs-manifest': sha },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['warning']).toMatch(/^299 - "VersionDeprecated Cart@1\.0\.0"/);
  });

  it('past-grace pin returns 410 Gone with expired refs', async () => {
    await publishCart('1.0.0');
    const sha = await resolveShaForCart('1.0.0');

    await h.driver.deprecateClassVersion(asClassName('Cart'), asVersion('1.0.0'), Date.now() - 1);

    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/manifest/${sha}`,
      headers: { 'x-actjs-manifest': sha },
    });
    expect(res.statusCode).toBe(410);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    const body = res.json() as {
      code: string;
      expired: Array<{ class: string; version: string }>;
    };
    expect(body.code).toBe('Gone');
    expect(body.expired).toEqual([{ class: 'Cart', version: '1.0.0' }]);
  });
});
