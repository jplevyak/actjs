/**
 * Class-version dep resolver.
 *
 * Pure function over an injected catalog lookup. Walks the dep
 * graph greedily; on conflict throws a structured {@link DepConflict}
 * with the path through deps that produced each incompatible range.
 *
 * Algorithm: maintain a per-class list of accumulated ranges. For
 * each class, pick the highest version that satisfies every range
 * AND is not deprecated. If a pick changes (because new constraints
 * arrived), re-walk that class's deps. Terminates when no pick
 * changes — typically one pass; pathological dep graphs may iterate
 * a few times before settling. Caps at 16 deep / 256 nodes.
 */
import semver from 'semver';

import type { ClassVersionRecord, StorageDriver } from '../storage/driver.js';
import { manifestFromEntries } from '../types/index.js';
import type { ClassName, Manifest, Version } from '../types/index.js';

/* ----------------------------------------------------------- Types */

export type CatalogLookup = (name: ClassName) => Promise<readonly ClassVersionRecord[]>;

/** A constraint accumulated by the resolver on a given class. */
export interface AccumulatedRange {
  /** The semver range string as it appeared in the dep map. */
  readonly range: string;
  /** Chain from the root that produced this range. */
  readonly path: readonly string[];
}

/** What the resolver returns. */
export interface ResolveResult {
  readonly manifest: Manifest;
  /**
   * The accumulated set of constraints per class that produced this
   * manifest. Useful for diagnostics and `actctl manifest show`.
   */
  readonly constraints: ReadonlyMap<ClassName, readonly AccumulatedRange[]>;
}

export interface ResolverOptions {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_NODES = 256;

/* --------------------------------------------------------- Errors */

export class ResolverError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ResolverError';
    this.code = code;
  }
}

export class DepConflict extends ResolverError {
  readonly className: ClassName;
  readonly accumulatedRanges: readonly AccumulatedRange[];
  constructor(name: ClassName, ranges: readonly AccumulatedRange[]) {
    super(
      `no version of ${name as string} satisfies all constraints: ` +
        ranges.map((r) => `${r.range} (via ${r.path.join(' → ')})`).join('; '),
      'DepConflict',
    );
    this.className = name;
    this.accumulatedRanges = ranges;
  }
}

export class ClassNotFound extends ResolverError {
  readonly className: ClassName;
  constructor(name: ClassName) {
    super(`class not found: ${name as string}`, 'ClassNotFound');
    this.className = name;
  }
}

export class LimitExceeded extends ResolverError {
  constructor(message: string) {
    super(message, 'LimitExceeded');
  }
}

/* ---------------------------------------------------- Public input */

export interface ResolveRoot {
  readonly name: ClassName;
  /** Semver range string (e.g. `^1.0.0`) or exact version. */
  readonly range: string;
}

/* ------------------------------------------------------- Algorithm */

/**
 * Resolve a list of root constraints into a pinned Manifest.
 *
 * Pure relative to its `catalog` argument. The catalog is the only
 * I/O surface; substitute it for unit tests.
 */
export async function resolve(
  roots: readonly ResolveRoot[],
  catalog: CatalogLookup,
  options: ResolverOptions = {},
): Promise<ResolveResult> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;

  const constraints = new Map<ClassName, AccumulatedRange[]>();
  const picked = new Map<ClassName, Version>();
  // Cache class catalogs across the walk; the catalog function may be slow.
  const catalogCache = new Map<ClassName, readonly ClassVersionRecord[]>();

  async function fetch(name: ClassName): Promise<readonly ClassVersionRecord[]> {
    const cached = catalogCache.get(name);
    if (cached) return cached;
    const fresh = await catalog(name);
    catalogCache.set(name, fresh);
    return fresh;
  }

  type QueueEntry = {
    name: ClassName;
    range: string;
    path: readonly string[];
  };

  const queue: QueueEntry[] = roots.map((r) => ({
    name: r.name,
    range: r.range,
    path: [`${r.name as string}@${r.range}`],
  }));

  let nodes = 0;

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.path.length > maxDepth * 2) {
      // path doubles every (class → version → dep), so depth d ↔ path length 2d+1
      throw new LimitExceeded(`resolver exceeded maxDepth=${maxDepth}`);
    }

    // Record the new constraint.
    let list = constraints.get(node.name);
    if (!list) {
      list = [];
      constraints.set(node.name, list);
    }
    list.push({ range: node.range, path: node.path });

    // Pick a version satisfying every accumulated constraint.
    const versions = await fetch(node.name);
    const candidate = pickHighest(versions, list);
    if (!candidate) {
      throw new DepConflict(node.name, list);
    }

    const prior = picked.get(node.name);
    if (prior === candidate.version) {
      // No change; no need to re-walk this class's deps.
      continue;
    }
    picked.set(node.name, candidate.version);
    nodes++;
    if (nodes > maxNodes) {
      throw new LimitExceeded(`resolver exceeded maxNodes=${maxNodes}`);
    }

    // Enqueue every dep with its range.
    for (const [depName, depRange] of Object.entries(candidate.deps)) {
      queue.push({
        name: depName as ClassName,
        range: depRange,
        path: [
          ...node.path,
          `${node.name as string}@${candidate.version as string}`,
          `${depName}@${depRange}`,
        ],
      });
    }
  }

  // Build the typed Manifest.
  const entries: [string, string][] = [];
  for (const [name, version] of picked) {
    entries.push([name as string, version as string]);
  }
  return {
    manifest: manifestFromEntries(entries),
    constraints,
  };
}

/* ------------------------------------------------------- Helpers */

function pickHighest(
  versions: readonly ClassVersionRecord[],
  constraints: readonly AccumulatedRange[],
): ClassVersionRecord | null {
  // Filter: non-deprecated AND satisfies every accumulated range.
  // `deprecatedAt !== undefined` rather than truthy: a zero timestamp
  // is a legal "deprecated at epoch" marker (the memory driver uses 0
  // in tests).
  const candidates = versions.filter((v) => {
    if (v.deprecatedAt !== undefined) return false;
    return constraints.every((c) => semver.satisfies(v.version as string, c.range));
  });
  if (candidates.length === 0) return null;
  // Sort descending by semver and take the head.
  candidates.sort((a, b) => semver.rcompare(a.version as string, b.version as string));
  return candidates[0]!;
}

/* ------------------------------------ Catalog helper from a driver */

/**
 * Adapt a {@link StorageDriver} into a {@link CatalogLookup} that
 * returns versions for a class. Returns an empty array if the class
 * has no versions, so the caller (resolver) decides whether to throw.
 */
export function catalogFromDriver(driver: StorageDriver): CatalogLookup {
  return async (name) => {
    const versions = await driver.listClassVersions(name);
    if (versions.length === 0) {
      throw new ClassNotFound(name);
    }
    return versions;
  };
}
