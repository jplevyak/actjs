/**
 * valkey-pg driver conformance tests.
 *
 * Runs the shared conformance suite against a real Valkey + Postgres
 * when `ACTJS_TEST_POSTGRES_URL` is set. Otherwise the entire suite
 * is skipped (CI's storage job sets the env; local dev runs `docker
 * compose up valkey postgres` first).
 *
 * Each test gets a fresh driver instance that connects to the same
 * backing services, with `__resetForTests` clearing the namespace.
 */
import { describe } from 'vitest';

import { ValkeyPgStorageDriver } from '../../src/storage/valkey-pg.js';

import { runConformance } from './conformance.js';

const POSTGRES_URL = process.env['ACTJS_TEST_POSTGRES_URL'];
const REDIS_URL = process.env['ACTJS_TEST_REDIS_URL'];

const enabled = Boolean(POSTGRES_URL);

if (!enabled) {
  describe.skip('valkey-pg driver — conformance (set ACTJS_TEST_POSTGRES_URL to enable)', () => {
    // intentional skip
  });
} else {
  runConformance('valkey-pg driver — conformance', async () => {
    const driver = new ValkeyPgStorageDriver({
      postgresUrl: POSTGRES_URL!,
      ...(REDIS_URL ? { redisUrl: REDIS_URL } : {}),
      applyMigrations: true,
    });
    await driver.init();
    await driver.__resetForTests();
    return driver;
  });
}
