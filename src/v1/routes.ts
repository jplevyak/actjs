/**
 * Express handlers for the Phase 4.1 publish + resolve API.
 *
 * Path layout:
 *   GET    /v1/classes                          — list class names
 *   POST   /v1/classes/:name/versions           — publish (admin)
 *   GET    /v1/classes/:name/versions           — list versions
 *   PATCH  /v1/classes/:name/versions/:version  — deprecate (admin)
 *   GET    /v1/manifest?root=&dep=              — resolve
 *
 * Routes are mounted via {@link registerV1Routes} so the same code
 * is reachable from `top.ts` (Express today, Fastify in Phase 5.1)
 * and from unit tests that spin up a minimal app.
 */
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import express from 'express';
import { z } from 'zod';

import { StatusError } from '../error.js';
import {
  DepConflict,
  IncompatibleEngine,
  InvalidDepRange,
  InvalidVersion,
  PublishError,
  publishClass,
  resolve,
  ResolverError,
  SyntaxInvalid,
  catalogFromDriver,
  type ResolveRoot,
} from '../registry/index.js';
import { VersionAlreadyPublishedError, type StorageDriver } from '../storage/driver.js';
import { asClassName, manifestSha256, type ClassName } from '../types/index.js';

const PublishBodySchema = z.object({
  version: z.string(),
  source: z.string(),
  deps: z.record(z.string(), z.string()).default({}),
  engines: z.record(z.string(), z.string()).default({}),
  floating: z.boolean().optional(),
  eventSourced: z.boolean().optional(),
});

const DeprecateBodySchema = z.object({
  deprecated: z.boolean(),
  graceUntilMs: z.number().int().nonnegative().optional(),
});

/* ------------------------------------------------------- Admin gate */

/**
 * Placeholder admin gate: accepts any request that sends
 * `X-Actjs-Admin: 1`. Phase 5.3 replaces this with the BYO
 * `auth(req)` hook + role check.
 */
const adminOnly: RequestHandler = (req, res, next) => {
  if (req.header('x-actjs-admin') === '1') {
    next();
    return;
  }
  res.status(403).json({ name: 'Forbidden', message: 'admin required (placeholder gate)' });
};

/* ------------------------------------------------------ Class-name helper */

function classNameFromParam(req: Request, paramName = 'name'): ClassName {
  const value = req.params[paramName];
  if (!value || typeof value !== 'string') {
    throw new StatusError('missing class name', 400);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new StatusError(`invalid class name: ${value}`, 400);
  }
  return asClassName(value);
}

/* ------------------------------------------------------- Error mapper */

function mapError(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof StatusError) {
    return { status: err.status, body: { name: err.name, message: err.message } };
  }
  if (err instanceof VersionAlreadyPublishedError) {
    return {
      status: 409,
      body: { name: err.name, code: err.code, message: err.message },
    };
  }
  if (err instanceof SyntaxInvalid) {
    return {
      status: 400,
      body: {
        name: err.name,
        code: err.code,
        message: err.message,
        diagnostics: err.diagnostics,
      },
    };
  }
  if (
    err instanceof InvalidVersion ||
    err instanceof InvalidDepRange ||
    err instanceof IncompatibleEngine ||
    err instanceof PublishError
  ) {
    return {
      status: 400,
      body: { name: err.name, code: err.code, message: err.message },
    };
  }
  if (err instanceof DepConflict) {
    return {
      status: 409,
      body: {
        name: err.name,
        code: err.code,
        message: err.message,
        class: err.className,
        ranges: err.accumulatedRanges,
      },
    };
  }
  if (err instanceof ResolverError) {
    return {
      status: 400,
      body: { name: err.name, code: err.code, message: err.message },
    };
  }
  return {
    status: 500,
    body: {
      name: 'InternalError',
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

function wrap(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next): void => {
    fn(req, res).catch((err: unknown) => {
      const mapped = mapError(err);
      if (!res.headersSent) {
        res.status(mapped.status).json(mapped.body);
      } else {
        next(err);
      }
    });
  };
}

/* ----------------------------------------------------- Parse manifest query */

const ROOT_RE = /^([A-Za-z_][A-Za-z0-9_]*)@(.+)$/;

function parseRootSpec(spec: string): ResolveRoot {
  const m = ROOT_RE.exec(spec);
  if (!m) throw new StatusError(`malformed root/dep spec: ${spec}`, 400);
  return { name: asClassName(m[1]!), range: m[2]! };
}

function collectQueryParam(req: Request, key: string): string[] {
  const v = req.query[key];
  if (v === undefined) return [];
  if (Array.isArray(v)) {
    return v.map((x) => (typeof x === 'string' ? x : String(x)));
  }
  return [typeof v === 'string' ? v : String(v)];
}

/* ----------------------------------------------------- Public mount */

export function registerV1Routes(app: Express, driver: StorageDriver): void {
  const jsonBody = express.json({ limit: '4mb' });

  // GET /v1/classes — list distinct class names that have any version.
  // Cheap to implement client-side by listing versions per class; we don't
  // have a "list all classes" driver method yet, so this returns the set
  // accumulated by recently-listed names. For Phase 4.1 we leave it
  // unimplemented (501) rather than half-bake it.
  app.get(
    '/v1/classes',
    wrap(async (_req, res) => {
      res.status(501).json({
        name: 'NotImplemented',
        message: 'class listing arrives with the registry index in Phase 4.2',
      });
    }),
  );

  // POST /v1/classes/:name/versions
  app.post(
    '/v1/classes/:name/versions',
    adminOnly,
    jsonBody,
    wrap(async (req, res) => {
      const name = classNameFromParam(req);
      const parsed = PublishBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new StatusError(`invalid publish body: ${parsed.error.message}`, 400);
      }
      const body = parsed.data;
      const { sha256 } = await publishClass(driver, {
        name,
        version: body.version as ReturnType<typeof asClassName> as never,
        source: body.source,
        deps: body.deps,
        engines: body.engines,
        ...(body.floating !== undefined ? { floating: body.floating } : {}),
        ...(body.eventSourced !== undefined ? { eventSourced: body.eventSourced } : {}),
        principal: req.header('x-actjs-admin-id') ?? 'admin',
      });
      res.status(201).json({ name, version: body.version, sha256 });
    }),
  );

  // GET /v1/classes/:name/versions
  app.get(
    '/v1/classes/:name/versions',
    wrap(async (req, res) => {
      const name = classNameFromParam(req);
      const versions = await driver.listClassVersions(name);
      res.json({ name, versions });
    }),
  );

  // PATCH /v1/classes/:name/versions/:version
  app.patch(
    '/v1/classes/:name/versions/:version',
    adminOnly,
    jsonBody,
    wrap(async (req, res) => {
      const name = classNameFromParam(req);
      const version = req.params['version'];
      if (typeof version !== 'string' || !version) {
        throw new StatusError('missing version', 400);
      }
      const parsed = DeprecateBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new StatusError(`invalid body: ${parsed.error.message}`, 400);
      }
      if (parsed.data.deprecated !== true) {
        throw new StatusError('only deprecation is supported (set deprecated: true)', 400);
      }
      const graceUntil = parsed.data.graceUntilMs;
      await driver.deprecateClassVersion(
        name,
        version as ReturnType<typeof asClassName> as never,
        graceUntil,
      );
      res.json({ name, version, deprecated: true, graceUntilMs: graceUntil });
    }),
  );

  // GET /v1/manifest?root=Cart@1.4.2&dep=Item@^1.0.0
  app.get(
    '/v1/manifest',
    wrap(async (req, res) => {
      const rootSpecs = collectQueryParam(req, 'root');
      const depSpecs = collectQueryParam(req, 'dep');
      if (rootSpecs.length === 0 && depSpecs.length === 0) {
        throw new StatusError('at least one ?root= or ?dep= is required', 400);
      }
      const roots: ResolveRoot[] = [
        ...rootSpecs.map(parseRootSpec),
        ...depSpecs.map(parseRootSpec),
      ];
      const { manifest, constraints } = await resolve(roots, catalogFromDriver(driver));
      const resolved: Record<string, string> = {};
      for (const [name, version] of manifest) {
        resolved[name as string] = version as string;
      }
      const sha = manifestSha256(manifest);
      // Save (idempotent) so Phase 4.3's client pin can reference it.
      await driver.saveManifest(sha, resolved);
      res.json({
        sha256: sha,
        resolved,
        constraints: serializeConstraints(constraints),
      });
    }),
  );
}

function serializeConstraints(
  constraints: ReadonlyMap<ClassName, readonly { range: string; path: readonly string[] }[]>,
): Record<string, Array<{ range: string; path: readonly string[] }>> {
  const out: Record<string, Array<{ range: string; path: readonly string[] }>> = {};
  for (const [name, list] of constraints) {
    out[name as string] = list.map((c) => ({ range: c.range, path: c.path }));
  }
  return out;
}

// `NextFunction` is referenced indirectly via Express's RequestHandler type
// — re-export here keeps it available without an explicit import warning.
export type { NextFunction };
