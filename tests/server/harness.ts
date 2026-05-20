/**
 * Test harness for the Fastify app: builds a fresh
 * MemoryStorageDriver + Runtime + app for each test, returning an
 * `app.inject(...)` handle.
 */
import { Runtime } from '../../src/runtime/index.js';
import { buildApp } from '../../src/server/app.js';
import { ManifestUsageTracker } from '../../src/server/manifest-tracker.js';
import { MemoryStorageDriver } from '../../src/storage/memory.js';

export interface TestHarness {
  driver: MemoryStorageDriver;
  runtime: Runtime;
  tracker: ManifestUsageTracker;
  app: Awaited<ReturnType<typeof buildApp>>;
  close: () => Promise<void>;
}

export async function buildHarness(): Promise<TestHarness> {
  const driver = new MemoryStorageDriver();
  await driver.init();
  const runtime = new Runtime(driver);
  const tracker = new ManifestUsageTracker();
  const app = await buildApp({
    driver,
    runtime,
    tracker,
    // Disable lastSeen sampling for deterministic counters.
    pinOptions: { lastSeenSampleEvery: 0 },
  });
  return {
    driver,
    runtime,
    tracker,
    app,
    close: async () => {
      await app.close();
      await runtime.shutdown();
      await driver.close();
    },
  };
}

export const ADMIN_HEADERS = {
  'x-actjs-admin': '1',
  'content-type': 'application/json',
};

export const VALID_SOURCE = `
class Cart extends actjs.Actor {
  constructor() { super(); }
}
return Cart;
`;
