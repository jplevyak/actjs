/**
 * Fastify app builder.
 *
 * `buildApp(options)` returns a configured Fastify instance with:
 *   - Zod type provider
 *   - RFC 7807 error handler (`application/problem+json`)
 *   - X-Actjs-Manifest pin preHandler + ManifestUsageTracker
 *   - Idempotency-Key pre/onSend hooks
 *   - OpenAPI 3.1 via @fastify/swagger
 *   - /v1/health, /v1/classes/*, /v1/manifest*, /v1/admin/*, /v1/actors/*
 *   - Legacy /run + /upload + GET /
 *
 * Caller hands in the long-lived StorageDriver and Runtime. Tests
 * use `app.inject(...)` for in-process round-trips; production
 * calls `app.listen(...)`.
 */
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import websocket from '@fastify/websocket';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import type { Runtime } from '../runtime/index.js';
import type { StorageDriver } from '../storage/driver.js';

import { handleError } from './errors.js';
import { makeIdempotencyHooks } from './hooks/idempotency.js';
import { makePinHook, type PinHookOptions } from './hooks/pin.js';
import { ManifestUsageTracker } from './manifest-tracker.js';
import { registerActorRoutes } from './routes/actors.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerClassRoutes } from './routes/classes.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerLegacyRoutes } from './routes/legacy.js';
import { registerManifestRoutes } from './routes/manifest.js';
import { registerWsRoute } from './routes/ws.js';
import { SubscriptionRegistry } from './subscription-registry.js';

/**
 * Fastify instance with the Zod type provider attached. Routes
 * registered against this type get `req.body` / `req.params` /
 * `req.query` inferred from their `schema.*` Zod definitions.
 */
export type TypedFastifyInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface BuildAppOptions {
  readonly driver: StorageDriver;
  readonly runtime: Runtime;
  readonly tracker?: ManifestUsageTracker;
  readonly redisUrl?: string;
  /** Override pin hook sampling for tests. */
  readonly pinOptions?: Partial<Omit<PinHookOptions, 'driver' | 'tracker'>>;
  /** Idempotency TTL in ms. Default 24h. */
  readonly idempotencyTtlMs?: number;
  readonly logger?: boolean;
  /** WS heartbeat ping interval (ms). Default 30s. */
  readonly wsPingIntervalMs?: number;
  /** WS heartbeat timeout (ms). Default 90s. */
  readonly wsPingTimeoutMs?: number;
  /** Per-actor subscriber cap (test seam). */
  readonly maxSubscribersPerActor?: number;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const tracker = options.tracker ?? new ManifestUsageTracker();
  const app = Fastify({ logger: options.logger ?? false }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(handleError);

  await app.register(multipart);
  await app.register(websocket);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'actjs',
        description: 'Self-hosted actor framework HTTP API',
        version: '0.3.0',
      },
      tags: [
        { name: 'health' },
        { name: 'classes' },
        { name: 'manifest' },
        { name: 'actors' },
        { name: 'admin' },
        { name: 'legacy' },
      ],
    },
  });

  // Pin preHandler. It's a no-op when the request lacks the
  // X-Actjs-Manifest header, so attaching unconditionally is cheap.
  // Legacy /run and /upload don't send the header in practice.
  const pinHookOpts: PinHookOptions = {
    driver: options.driver,
    tracker,
    ...(options.pinOptions ?? {}),
  };
  app.addHook('preHandler', makePinHook(pinHookOpts));

  // Idempotency hooks (mutating methods only).
  const idem = makeIdempotencyHooks({
    driver: options.driver,
    ...(options.idempotencyTtlMs !== undefined ? { ttlMs: options.idempotencyTtlMs } : {}),
  });
  app.addHook('preHandler', idem.preHandler);
  app.addHook('onSend', idem.onSend);

  // Routes.
  const typedApp = app as unknown as TypedFastifyInstance;
  registerHealthRoutes(typedApp);
  registerClassRoutes(typedApp, options.driver);
  registerManifestRoutes(typedApp, options.driver);
  registerAdminRoutes(typedApp, tracker);
  registerActorRoutes(typedApp, options.driver, options.runtime);

  await registerLegacyRoutes(
    app,
    options.redisUrl !== undefined ? { redisUrl: options.redisUrl } : {},
  );

  // WebSocket / JSON-RPC subscriptions.
  const registry = new SubscriptionRegistry(
    options.runtime,
    options.maxSubscribersPerActor !== undefined
      ? { maxPerActor: options.maxSubscribersPerActor }
      : {},
  );
  await registerWsRoute(app, {
    runtime: options.runtime,
    registry,
    ...(options.wsPingIntervalMs !== undefined ? { pingIntervalMs: options.wsPingIntervalMs } : {}),
    ...(options.wsPingTimeoutMs !== undefined ? { pingTimeoutMs: options.wsPingTimeoutMs } : {}),
  });

  // OpenAPI document.
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  return app;
}
