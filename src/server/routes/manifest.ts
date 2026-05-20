/**
 * Manifest routes:
 *   GET /v1/manifest?root=&dep=     — resolve & store
 *   GET /v1/manifest/:sha           — retrieve stored
 */
import { z } from 'zod';

import { StatusError } from '../../error.js';
import { catalogFromDriver, resolve, type ResolveRoot } from '../../registry/index.js';
import type { StorageDriver } from '../../storage/driver.js';
import { asClassName, manifestSha256, type ClassName } from '../../types/index.js';
import type { TypedFastifyInstance } from '../app.js';

const ROOT_RE = /^([A-Za-z_][A-Za-z0-9_]*)@(.+)$/;

const ResolveQuery = z.object({
  root: z.union([z.string(), z.array(z.string())]).optional(),
  dep: z.union([z.string(), z.array(z.string())]).optional(),
});

const ResolveResponse = z.object({
  sha256: z.string(),
  resolved: z.record(z.string(), z.string()),
  constraints: z.record(
    z.string(),
    z.array(
      z.object({
        range: z.string(),
        path: z.array(z.string()),
      }),
    ),
  ),
});

const ShaParam = z.object({
  sha: z.string().regex(/^[0-9a-f]{64}$/, 'malformed manifest sha'),
});

const RetrieveResponse = z.object({
  sha256: z.string(),
  resolved: z.record(z.string(), z.string()),
});

function asArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function parseRootSpec(spec: string): ResolveRoot {
  const m = ROOT_RE.exec(spec);
  if (!m) throw new StatusError(`malformed root/dep spec: ${spec}`, 400);
  return { name: asClassName(m[1]!), range: m[2]! };
}

function serializeConstraints(
  constraints: ReadonlyMap<ClassName, readonly { range: string; path: readonly string[] }[]>,
): Record<string, Array<{ range: string; path: string[] }>> {
  const out: Record<string, Array<{ range: string; path: string[] }>> = {};
  for (const [name, list] of constraints) {
    out[name as string] = list.map((c) => ({ range: c.range, path: [...c.path] }));
  }
  return out;
}

export function registerManifestRoutes(app: TypedFastifyInstance, driver: StorageDriver): void {
  app.get(
    '/v1/manifest',
    {
      schema: {
        summary: 'Resolve a fresh manifest',
        tags: ['manifest'],
        querystring: ResolveQuery,
        response: { 200: ResolveResponse },
      },
    },
    async (req) => {
      const rootSpecs = asArray(req.query.root);
      const depSpecs = asArray(req.query.dep);
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
      await driver.saveManifest(sha, resolved);
      return {
        sha256: sha,
        resolved,
        constraints: serializeConstraints(constraints),
      };
    },
  );

  app.get(
    '/v1/manifest/:sha',
    {
      schema: {
        summary: 'Retrieve a stored manifest',
        tags: ['manifest'],
        params: ShaParam,
        response: { 200: RetrieveResponse },
      },
    },
    async (req) => {
      const { sha } = req.params;
      const resolved = await driver.loadManifest(sha);
      if (!resolved) {
        throw new ManifestUnknownError(sha);
      }
      return { sha256: sha, resolved };
    },
  );
}

class ManifestUnknownError extends StatusError {
  constructor(sha: string) {
    super(`no manifest stored at sha ${sha}`, 404);
    this.name = 'ManifestUnknown';
  }
}
