/**
 * Class-management routes:
 *   POST   /v1/classes/:name/versions  — publish (admin)
 *   GET    /v1/classes/:name/versions  — list
 *   PATCH  /v1/classes/:name/versions/:version  — deprecate (admin)
 *   GET    /v1/classes                 — index (not implemented in v1)
 */
import { z } from 'zod';

import { StatusError } from '../../error.js';
import { publishClass } from '../../registry/index.js';
import type { StorageDriver } from '../../storage/driver.js';
import { asClassName, asVersion } from '../../types/index.js';
import { adminOnly } from '../admin.js';
import type { TypedFastifyInstance } from '../app.js';

const ClassNameParam = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'invalid class name'),
});

const VersionParam = ClassNameParam.extend({
  version: z.string().min(1),
});

const PublishBody = z.object({
  version: z.string(),
  source: z.string(),
  deps: z.record(z.string(), z.string()).default({}),
  engines: z.record(z.string(), z.string()).default({}),
  floating: z.boolean().optional(),
  eventSourced: z.boolean().optional(),
});

const PublishResponse = z.object({
  name: z.string(),
  version: z.string(),
  sha256: z.string(),
});

const ListResponse = z.object({
  name: z.string(),
  versions: z.array(
    z.object({
      name: z.string(),
      version: z.string(),
      sourceSha256: z.string(),
      deps: z.record(z.string(), z.string()),
      engines: z.record(z.string(), z.string()),
      publishedAt: z.number(),
      deprecatedAt: z.number().optional(),
      graceUntil: z.number().optional(),
      signedBy: z.string().optional(),
      floating: z.boolean(),
      eventSourced: z.boolean(),
    }),
  ),
});

const DeprecateBody = z.object({
  deprecated: z.literal(true),
  graceUntilMs: z.number().int().nonnegative().optional(),
});

const DeprecateResponse = z.object({
  name: z.string(),
  version: z.string(),
  deprecated: z.literal(true),
  graceUntilMs: z.number().optional(),
});

const NotImplementedResponse = z.object({
  type: z.string(),
  title: z.string(),
  status: z.literal(501),
  code: z.literal('NotImplemented'),
  detail: z.string(),
});

export function registerClassRoutes(app: TypedFastifyInstance, driver: StorageDriver): void {
  app.get(
    '/v1/classes',
    {
      schema: {
        summary: 'List all class names (not implemented in v1)',
        tags: ['classes'],
        response: { 501: NotImplementedResponse },
      },
    },
    async (_req, reply) => {
      await reply.code(501).header('content-type', 'application/problem+json').send({
        type: 'https://actjs.dev/errors/NotImplemented',
        title: 'NotImplemented',
        status: 501,
        code: 'NotImplemented',
        detail: 'class index arrives with the registry index in a later phase',
      });
    },
  );

  app.post(
    '/v1/classes/:name/versions',
    {
      preHandler: adminOnly,
      schema: {
        summary: 'Publish a class version (admin)',
        tags: ['classes'],
        params: ClassNameParam,
        body: PublishBody,
        response: { 201: PublishResponse },
      },
    },
    async (req, reply) => {
      const name = asClassName(req.params.name);
      const body = req.body;
      const { sha256 } = await publishClass(driver, {
        name,
        version: asVersion(body.version),
        source: body.source,
        deps: body.deps,
        engines: body.engines,
        ...(body.floating !== undefined ? { floating: body.floating } : {}),
        ...(body.eventSourced !== undefined ? { eventSourced: body.eventSourced } : {}),
        principal: (req.headers['x-actjs-admin-id'] as string | undefined) ?? 'admin',
      });
      await reply.code(201).send({ name, version: body.version, sha256 });
    },
  );

  app.get(
    '/v1/classes/:name/versions',
    {
      schema: {
        summary: 'List published versions of a class',
        tags: ['classes'],
        params: ClassNameParam,
        response: { 200: ListResponse },
      },
    },
    async (req) => {
      const name = asClassName(req.params.name);
      const versions = await driver.listClassVersions(name);
      return {
        name,
        versions: versions.map((v) => ({
          name: v.name as string,
          version: v.version as string,
          sourceSha256: v.sourceSha256,
          deps: v.deps,
          engines: v.engines,
          publishedAt: v.publishedAt,
          ...(v.deprecatedAt !== undefined ? { deprecatedAt: v.deprecatedAt } : {}),
          ...(v.graceUntil !== undefined ? { graceUntil: v.graceUntil } : {}),
          ...(v.signedBy !== undefined ? { signedBy: v.signedBy } : {}),
          floating: v.floating,
          eventSourced: v.eventSourced,
        })),
      };
    },
  );

  app.patch(
    '/v1/classes/:name/versions/:version',
    {
      preHandler: adminOnly,
      schema: {
        summary: 'Deprecate a class version (admin)',
        tags: ['classes'],
        params: VersionParam,
        body: DeprecateBody,
        response: { 200: DeprecateResponse },
      },
    },
    async (req) => {
      const name = asClassName(req.params.name);
      const version = req.params.version;
      const graceUntil = req.body.graceUntilMs;
      if (!/^\d+\.\d+\.\d+/.test(version)) {
        throw new StatusError(`invalid semver version in path: ${version}`, 400);
      }
      await driver.deprecateClassVersion(name, asVersion(version), graceUntil);
      return {
        name,
        version,
        deprecated: true as const,
        ...(graceUntil !== undefined ? { graceUntilMs: graceUntil } : {}),
      };
    },
  );
}
