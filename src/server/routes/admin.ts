/**
 * Admin routes:
 *   GET /v1/admin/manifests/in-use — returns the in-process tracker report.
 *
 * Phase 8.2's `actctl manifest in-use` will query this endpoint.
 */
import { z } from 'zod';

import { StatusError } from '../../error.js';
import type { SigningKeyRegistry } from '../../registry/index.js';
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

const KeyAddBody = z.object({
  publicKeyPem: z.string(),
});

const KeyResponse = z.object({
  kid: z.string(),
  algorithm: z.string(),
  addedAt: z.number(),
  revokedAt: z.number().optional(),
});

const KeyParam = z.object({ kid: z.string().min(1) });

export interface AdminRoutesOptions {
  readonly signingKeys?: SigningKeyRegistry;
}

export function registerAdminRoutes(
  app: TypedFastifyInstance,
  tracker: ManifestUsageTracker,
  options: AdminRoutesOptions = {},
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

  if (options.signingKeys) {
    const signingKeys = options.signingKeys;
    app.post(
      '/v1/admin/signing-keys/:kid',
      {
        preHandler: adminOnly,
        schema: {
          summary: 'Register a signing public key (admin)',
          tags: ['admin'],
          params: KeyParam,
          body: KeyAddBody,
          response: { 201: KeyResponse },
        },
      },
      async (req, reply) => {
        await signingKeys.add(
          req.params.kid,
          req.body.publicKeyPem,
          (req.headers['x-actjs-admin-id'] as string | undefined) ?? 'admin',
        );
        const rec = await signingKeys.get(req.params.kid);
        if (!rec) throw new StatusError('signing key disappeared after add', 500);
        await reply.code(201).send({
          kid: rec.kid,
          algorithm: rec.algorithm,
          addedAt: rec.addedAt,
          ...(rec.revokedAt !== undefined ? { revokedAt: rec.revokedAt } : {}),
        });
      },
    );
    app.delete(
      '/v1/admin/signing-keys/:kid',
      {
        preHandler: adminOnly,
        schema: {
          summary: 'Revoke a signing key (admin)',
          tags: ['admin'],
          params: KeyParam,
          response: { 200: KeyResponse },
        },
      },
      async (req) => {
        await signingKeys.revoke(
          req.params.kid,
          (req.headers['x-actjs-admin-id'] as string | undefined) ?? 'admin',
        );
        const rec = await signingKeys.get(req.params.kid);
        if (!rec) throw new StatusError('signing key not found', 404);
        return {
          kid: rec.kid,
          algorithm: rec.algorithm,
          addedAt: rec.addedAt,
          ...(rec.revokedAt !== undefined ? { revokedAt: rec.revokedAt } : {}),
        };
      },
    );
  }
}
