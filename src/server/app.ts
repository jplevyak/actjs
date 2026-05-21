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

import { makeLogger, makeNoopLogger, type Logger } from '../log/index.js';
import type { MetricsRegistry } from '../metrics/index.js';
import type { Blocklist } from '../policy/blocklist.js';
import type { SigningKeyRegistry } from '../registry/index.js';
import type { Runtime } from '../runtime/index.js';
import type { StorageDriver } from '../storage/driver.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Per-request structured logger; carries `requestId` already. */
    actjsLog?: Logger;
  }
  interface FastifyInstance {
    actjsLog: Logger;
  }
}

import { makeAuthHook, type AuthHook } from './auth.js';
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
import { registerMetricsRoute } from './routes/metrics.js';
import { registerSseRoute } from './routes/sse.js';
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
  /**
   * Structured logger surface. Defaults to a pino-backed instance
   * (or noop under NODE_ENV=test / VITEST) so all subsystems share
   * the same logger. Pass `false` to suppress logging entirely.
   */
  readonly log?: Logger | false;
  /** WS heartbeat ping interval (ms). Default 30s. */
  readonly wsPingIntervalMs?: number;
  /** WS heartbeat timeout (ms). Default 90s. */
  readonly wsPingTimeoutMs?: number;
  /** Per-actor subscriber cap (test seam). */
  readonly maxSubscribersPerActor?: number;
  /**
   * Authentication hook. Called on every request; the resolved
   * Principal lands on `req.principal`. When omitted the app runs
   * fully open with `Principal.anonymous()` (warned at startup outside
   * NODE_ENV=development).
   */
  readonly auth?: AuthHook;
  /** If true and `auth` returns null/undefined the request gets 401. */
  readonly requireAuth?: boolean;
  /** SSE keep-alive interval (ms). Default 25 s. */
  readonly sseKeepAliveMs?: number;
  /**
   * Capability blocklist. When set, the auth hook checks each
   * presented capability against the list before honoring it. The
   * matching public key is read from `runtime.capabilityIssuer`.
   */
  readonly capabilityBlocklist?: Blocklist;
  /**
   * Signing-key registry. When set, `POST /v1/classes/...` accepts
   * `signature` + `kid` body fields; the verified kid lands on the
   * `class_version` row and an `class.signed` audit entry. The
   * registry's `add` / `revoke` methods power the
   * `/v1/admin/signing-keys/*` endpoints.
   */
  readonly signingKeys?: SigningKeyRegistry;
  /** When true, publishes without a verifiable signature are rejected. */
  readonly requireSignedClasses?: boolean;
  /**
   * Override the metrics registry exposed at `/metrics`. Defaults to
   * `options.runtime.metrics` when that registry is non-noop.
   */
  readonly metrics?: MetricsRegistry;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const runtimeMetrics = options.runtime.metrics;
  const metricsForRoute = options.metrics ?? pickRealMetricsRegistry(runtimeMetrics);
  const tracker =
    options.tracker ??
    new ManifestUsageTracker({
      ...(metricsForRoute ? { metrics: metricsForRoute } : {}),
    });
  const log = resolveLogger(options.log, options.runtime);
  const app = Fastify({ logger: options.logger ?? false }).withTypeProvider<ZodTypeProvider>();
  app.decorate('actjsLog', log);
  app.addHook('onRequest', async (req) => {
    const reqLog = log.child({ requestId: req.id, subsystem: 'server' });
    (req as { actjsLog?: Logger }).actjsLog = reqLog;
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(handleError);

  await app.register(multipart);
  await app.register(websocket);

  // Auth hook: runs first so admin / role checks can read req.principal.
  const env = process.env['NODE_ENV'];
  if (!options.auth && env !== 'development' && env !== 'test' && !process.env['VITEST']) {
    // Single-shot warning. We can't reach a structured logger before
    // it's wired, so use stderr — operators will see this in their
    // boot sequence and either supply an `auth` hook or accept the
    // open-by-default behavior for local/dev.
    console.warn(
      'actjs: no `auth` hook configured; every request will be anonymous. ' +
        'Set NODE_ENV=development to silence this warning.',
    );
  }
  // If the runtime has a CapabilityIssuer, the auth hook can also
  // verify `Authorization: Capability …` headers. The issuer's
  // public key is the verification key; the blocklist (if any)
  // gates revoked jtis.
  const capabilityIssuer = options.runtime.capabilityIssuer;
  const capabilityConfig =
    capabilityIssuer !== null
      ? {
          publicKey: capabilityIssuer.publicKey,
          ...(options.capabilityBlocklist ? { blocklist: options.capabilityBlocklist } : {}),
        }
      : undefined;
  app.addHook(
    'preHandler',
    makeAuthHook({
      ...(options.auth ? { auth: options.auth } : {}),
      ...(options.requireAuth !== undefined ? { requireAuth: options.requireAuth } : {}),
      ...(capabilityConfig ? { capability: capabilityConfig } : {}),
    }),
  );

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
  const auditor = options.runtime.auditor;
  registerHealthRoutes(typedApp);
  registerClassRoutes(typedApp, options.driver, {
    auditor,
    ...(options.signingKeys ? { signingKeys: options.signingKeys } : {}),
    ...(options.requireSignedClasses ? { requireSignedClasses: true } : {}),
  });
  registerManifestRoutes(typedApp, options.driver);
  registerAdminRoutes(typedApp, tracker, {
    ...(options.signingKeys ? { signingKeys: options.signingKeys } : {}),
  });
  registerActorRoutes(typedApp, options.driver, options.runtime);

  await registerLegacyRoutes(app, {
    ...(options.redisUrl !== undefined ? { redisUrl: options.redisUrl } : {}),
    auditor,
  });

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

  // SSE fallback transport.
  registerSseRoute(typedApp, {
    runtime: options.runtime,
    driver: options.driver,
    registry,
    ...(options.sseKeepAliveMs !== undefined ? { keepAliveMs: options.sseKeepAliveMs } : {}),
  });

  // OpenAPI document.
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  // /metrics — only when a real metrics registry is wired.
  if (metricsForRoute) {
    registerMetricsRoute(typedApp, { metrics: metricsForRoute });
  }

  return app;
}

function pickRealMetricsRegistry(m: MetricsRegistry | undefined): MetricsRegistry | undefined {
  if (!m) return undefined;
  // Filter out NoopMetricsRegistry — only an explicit caller-provided
  // metrics object should light up the route.
  if (m.constructor.name === 'NoopMetricsRegistry') return undefined;
  return m;
}

function resolveLogger(override: BuildAppOptions['log'], runtime: Runtime): Logger {
  if (override === false) return makeNoopLogger();
  if (override) return override;
  // If the runtime came with a non-noop logger (operator wired it
  // explicitly), share it so server + runtime + bridge events thread
  // through the same destination.
  const runtimeLog = runtime.log;
  if (runtimeLog.level !== 'silent') return runtimeLog;
  const env = process.env['NODE_ENV'];
  if (env === 'test' || process.env['VITEST']) return makeNoopLogger();
  return makeLogger();
}
