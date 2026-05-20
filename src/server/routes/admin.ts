/**
 * Admin routes:
 *   GET /v1/admin/manifests/in-use — returns the in-process tracker report.
 *
 * Phase 8.2's `actctl manifest in-use` will query this endpoint.
 */
import { z } from 'zod';

import { adminOnly } from '../admin.js';
import type { TypedFastifyInstance } from '../app.js';
import type { ManifestUsageTracker } from '../manifest-tracker.js';

const InUseEntry = z.object({
  sha: z.string(),
  count: z.number(),
  lastSeen: z.number(),
  resolved: z.record(z.string(), z.string()).optional(),
});

const InUseResponse = z.object({
  entries: z.array(InUseEntry),
  otherCount: z.number(),
  otherLastSeen: z.number(),
});

export function registerAdminRoutes(
  app: TypedFastifyInstance,
  tracker: ManifestUsageTracker,
): void {
  app.get(
    '/v1/admin/manifests/in-use',
    {
      preHandler: adminOnly,
      schema: {
        summary: 'Report which manifest shas are currently in use',
        tags: ['admin'],
        response: { 200: InUseResponse },
      },
    },
    async () => {
      const report = tracker.report();
      // The tracker returns `readonly` views; the response shape is
      // mutable per the Zod schema, so spread into a fresh object.
      return {
        entries: report.entries.map((e) => ({
          sha: e.sha,
          count: e.count,
          lastSeen: e.lastSeen,
          ...(e.resolved ? { resolved: e.resolved } : {}),
        })),
        otherCount: report.otherCount,
        otherLastSeen: report.otherLastSeen,
      };
    },
  );
}
