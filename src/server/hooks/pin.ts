/**
 * Fastify preHandler hook that validates the `X-Actjs-Manifest`
 * pin, classifies pinned class versions for deprecation, and
 * records usage into the {@link ManifestUsageTracker}.
 *
 * Port of the Express middleware that lived at
 * `src/v1/pin-middleware.ts` through Phase 4.3. The Fastify
 * version uses request decorators and `reply.send` to short-circuit
 * — no `next()` callback.
 */
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

import { StatusError } from '../../error.js';
import type { ClassVersionRecord, ResolvedManifest, StorageDriver } from '../../storage/driver.js';
import type { ClassName, Version } from '../../types/ids.js';
import type { ManifestUsageTracker } from '../manifest-tracker.js';

declare module 'fastify' {
  interface FastifyRequest {
    manifestPin?: PinContext;
  }
}

export interface PinContext {
  readonly sha: string;
  readonly resolved: ResolvedManifest;
  readonly deprecatedRefs: readonly { name: ClassName; version: Version }[];
}

export interface PinHookOptions {
  readonly driver: StorageDriver;
  readonly tracker: ManifestUsageTracker;
  /** Default 100; 0 disables the lastSeen sampling write. */
  readonly lastSeenSampleEvery?: number;
  /** Test seam. */
  readonly now?: () => number;
  /** Test seam: deterministic sampling. */
  readonly randomInt?: (n: number) => number;
}

const HEADER = 'x-actjs-manifest';
const QUERY_PARAM = 'manifest';
const SAMPLE_DEFAULT = 100;

export function makePinHook(options: PinHookOptions): preHandlerAsyncHookHandler {
  const { driver, tracker } = options;
  const now = options.now ?? Date.now;
  const sampleEvery = options.lastSeenSampleEvery ?? SAMPLE_DEFAULT;
  const randomInt = options.randomInt ?? ((n: number): number => Math.floor(Math.random() * n));

  return async function pinHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const sha = pinShaFor(req);
    if (!sha) return;

    const resolved = await driver.loadManifest(sha);
    if (!resolved) {
      throw new StatusError(`no manifest stored at sha ${sha}`, 400);
    }
    tracker.record(sha, resolved);
    if (sampleEvery > 0 && randomInt(sampleEvery) === 0) {
      await driver.saveManifest(sha, resolved).catch(() => undefined);
    }

    const { deprecated, expired } = await classifyPin(driver, resolved, now());
    if (expired.length > 0) {
      const refs = expired.map((r) => ({ class: r.name, version: r.version }));
      const first = expired[0]!;
      await reply
        .code(410)
        .header('content-type', 'application/problem+json')
        .send({
          type: 'https://actjs.dev/errors/Gone',
          title: 'Gone',
          status: 410,
          code: 'Gone',
          detail:
            `class ${first.name as string}@${first.version as string} is past its grace window; ` +
            `the pinned manifest references it. Re-resolve against the current registry.`,
          expired: refs,
        });
      return;
    }
    if (deprecated.length > 0) {
      const refs = deprecated.map((r) => `${r.name as string}@${r.version as string}`).join(', ');
      void reply.header('Warning', `299 - "VersionDeprecated ${refs}"`);
    }
    req.manifestPin = { sha, resolved, deprecatedRefs: deprecated };
  };
}

/**
 * Manifest pin sha resolution. Header takes precedence over query.
 * Query is supported for `EventSource` clients which can't set
 * arbitrary headers; everywhere else the header is preferred so the
 * sha doesn't leak into request logs and caches.
 */
function pinShaFor(req: FastifyRequest): string | null {
  const header = req.headers[HEADER];
  if (typeof header === 'string' && header.length > 0) return header;
  const query = req.query as Record<string, unknown> | undefined;
  const fromQuery = query?.[QUERY_PARAM];
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
  return null;
}

async function classifyPin(
  driver: StorageDriver,
  resolved: ResolvedManifest,
  nowMs: number,
): Promise<{
  deprecated: { name: ClassName; version: Version }[];
  expired: { name: ClassName; version: Version }[];
}> {
  const deprecated: { name: ClassName; version: Version }[] = [];
  const expired: { name: ClassName; version: Version }[] = [];
  for (const [name, version] of Object.entries(resolved)) {
    const list = await driver.listClassVersions(name as ClassName);
    const record = list.find((r) => (r.version as string) === version);
    if (!record) continue;
    const status = deprecationStatus(record, nowMs);
    if (status === 'expired') {
      expired.push({ name: name as ClassName, version: version as Version });
    } else if (status === 'deprecated') {
      deprecated.push({ name: name as ClassName, version: version as Version });
    }
  }
  return { deprecated, expired };
}

function deprecationStatus(
  record: ClassVersionRecord,
  nowMs: number,
): 'healthy' | 'deprecated' | 'expired' {
  if (record.deprecatedAt === undefined) return 'healthy';
  if (record.graceUntil !== undefined && record.graceUntil <= nowMs) {
    return 'expired';
  }
  return 'deprecated';
}
