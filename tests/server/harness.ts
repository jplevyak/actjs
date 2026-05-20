/**
 * Test harness for the Fastify app: builds a fresh
 * MemoryStorageDriver + Runtime + app for each test, returning an
 * `app.inject(...)` handle.
 */
import { Runtime } from '../../src/runtime/index.js';
import { buildApp } from '../../src/server/app.js';
import type { AuthHook, Principal } from '../../src/server/auth.js';
import { ManifestUsageTracker } from '../../src/server/manifest-tracker.js';
import { MemoryStorageDriver } from '../../src/storage/memory.js';

export interface HarnessOptions {
  /** Override the test auth hook. Defaults to `defaultTestAuth`. */
  readonly auth?: AuthHook | null;
  /** Pass through to buildApp. */
  readonly requireAuth?: boolean;
}

export interface TestHarness {
  driver: MemoryStorageDriver;
  runtime: Runtime;
  tracker: ManifestUsageTracker;
  app: Awaited<ReturnType<typeof buildApp>>;
  close: () => Promise<void>;
}

/**
 * Default test auth hook. Maps `X-Actjs-Admin: 1` to an admin principal,
 * `Authorization: Bearer user-*` to a non-admin user principal, and
 * everything else to anonymous.
 *
 * Production servers use a real `auth(req)` implementation; tests
 * exercising auth specifically can pass `auth: ...` to override.
 */
export const defaultTestAuth: AuthHook = (req) => {
  if (req.headers['x-actjs-admin'] === '1') {
    return { sub: 'test-admin', roles: ['admin'] } satisfies Principal;
  }
  const authz = req.headers['authorization'];
  if (typeof authz === 'string' && authz.startsWith('Bearer ')) {
    const token = authz.slice('Bearer '.length).trim();
    if (token.startsWith('admin-')) {
      return { sub: token, roles: ['admin'] } satisfies Principal;
    }
    if (token.length > 0) {
      return { sub: token, roles: [] } satisfies Principal;
    }
  }
  return null;
};

export async function buildHarness(options: HarnessOptions = {}): Promise<TestHarness> {
  const driver = new MemoryStorageDriver();
  await driver.init();
  const runtime = new Runtime(driver);
  const tracker = new ManifestUsageTracker();
  const auth = options.auth === null ? undefined : (options.auth ?? defaultTestAuth);
  const app = await buildApp({
    driver,
    runtime,
    tracker,
    // Disable lastSeen sampling for deterministic counters.
    pinOptions: { lastSeenSampleEvery: 0 },
    ...(auth ? { auth } : {}),
    ...(options.requireAuth !== undefined ? { requireAuth: options.requireAuth } : {}),
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
