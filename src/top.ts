/**
 * actjs server entry.
 *
 * Builds the Fastify app via {@link buildApp} and binds to `PORT`.
 * When `DATABASE_URL` (or `POSTGRES_URL`) is unset, the server still
 * boots — only the legacy /run + /upload paths are then useful.
 */
import { Runtime } from './runtime/index.js';
import { buildApp } from './server/app.js';
import { MemoryStorageDriver, ValkeyPgStorageDriver, type StorageDriver } from './storage/index.js';

const PORT = Number(process.argv[2] ?? process.env['PORT'] ?? 3000);
const REDIS_URL = process.env['REDIS_URL'];
const POSTGRES_URL = process.env['DATABASE_URL'] ?? process.env['POSTGRES_URL'];

let driver: StorageDriver;
if (POSTGRES_URL) {
  driver = new ValkeyPgStorageDriver({
    postgresUrl: POSTGRES_URL,
    ...(REDIS_URL ? { redisUrl: REDIS_URL } : {}),
  });
} else {
  console.warn(
    'no DATABASE_URL — using the in-memory storage driver. Suitable for ' +
      'local development only; published classes and actor state do not survive a restart.',
  );
  driver = new MemoryStorageDriver();
}
await driver.init();

const runtime = new Runtime(driver);

const app = await buildApp({
  driver,
  runtime,
  ...(REDIS_URL ? { redisUrl: REDIS_URL } : {}),
});

await app.listen({ host: '0.0.0.0', port: PORT });
console.info(`actjs listening on port ${PORT}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.info(`received ${sig}, shutting down`);
    void (async () => {
      await app.close();
      await runtime.shutdown();
      await driver.close();
      process.exit(0);
    })();
  });
}
