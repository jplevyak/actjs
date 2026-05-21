/**
 * Prometheus `/metrics` endpoint.
 *
 * The route is registered only when the operator passes a
 * {@link MetricsRegistry} to `buildApp(...)`. It's intentionally
 * open by default — operators behind a reverse proxy / network
 * policy don't need extra auth, and `prom-client` data is non-
 * sensitive. Operators that need auth can layer their `auth`
 * preHandler over the route or expose it on a separate listener.
 */
import type { MetricsRegistry } from '../../metrics/index.js';
import type { TypedFastifyInstance } from '../app.js';

export interface MetricsRouteOptions {
  readonly metrics: MetricsRegistry;
  /** URL path. Default `/metrics`. */
  readonly path?: string;
}

export function registerMetricsRoute(
  app: TypedFastifyInstance,
  options: MetricsRouteOptions,
): void {
  const path = options.path ?? '/metrics';
  app.get(
    path,
    {
      schema: {
        summary: 'Prometheus metrics scrape endpoint',
        tags: ['metrics'],
        hide: true,
      },
    },
    async (_req, reply) => {
      const body = await options.metrics.render();
      await reply.code(200).header('content-type', options.metrics.contentType).send(body);
    },
  );
}
