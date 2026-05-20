/**
 * OpenAPI 3.1 snapshot test.
 *
 * Set UPDATE_OPENAPI=1 to refresh the committed fixture.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildHarness, type TestHarness } from './harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', 'fixtures', 'openapi.json');

let h: TestHarness;
beforeEach(async () => {
  h = await buildHarness();
});
afterEach(async () => {
  await h.close();
});

describe('GET /openapi.json', () => {
  it('returns an OpenAPI 3.1 document', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { openapi: string; info: { title: string }; paths: object };
    expect(body.openapi).toBe('3.1.0');
    expect(body.info.title).toBe('actjs');
    // Spot-check that key routes are documented.
    expect(body.paths).toHaveProperty('/v1/health');
    expect(body.paths).toHaveProperty('/v1/classes/{name}/versions');
    expect(body.paths).toHaveProperty('/v1/manifest');
    expect(body.paths).toHaveProperty('/v1/actors/{class}/{id}/{method}');
  });

  it('byte-matches the committed snapshot (set UPDATE_OPENAPI=1 to refresh)', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/openapi.json' });
    const live = JSON.stringify(res.json(), null, 2) + '\n';

    if (process.env['UPDATE_OPENAPI'] === '1') {
      writeFileSync(FIXTURE, live);
      return;
    }
    if (!existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, live);
      // First-time run: write the fixture and pass.
      return;
    }
    const committed = readFileSync(FIXTURE, 'utf8');
    expect(live).toBe(committed);
  });
});
