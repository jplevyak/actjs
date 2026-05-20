import { z } from 'zod';

import type { TypedFastifyInstance } from '../app.js';

const HealthResponse = z.object({
  status: z.literal('ok'),
  uptimeMs: z.number().int().nonnegative(),
});

export function registerHealthRoutes(app: TypedFastifyInstance): void {
  const startedAt = Date.now();
  app.get(
    '/v1/health',
    {
      schema: {
        summary: 'Liveness check',
        tags: ['health'],
        response: { 200: HealthResponse },
      },
    },
    async () => ({
      status: 'ok' as const,
      uptimeMs: Date.now() - startedAt,
    }),
  );
}
