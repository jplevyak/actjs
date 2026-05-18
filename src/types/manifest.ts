import { createHash } from 'node:crypto';

import type { ClassName, Version } from './ids.js';

/**
 * A pinned mapping from class name to resolved version, used as the
 * single source of truth for which class versions a request runs
 * against. Carried through every actor-to-actor call so the call
 * stack stays consistent end-to-end.
 *
 * Read-only by contract — once handed to the runtime, the runtime
 * may not mutate it. Mutate by building a fresh Map.
 */
export type Manifest = ReadonlyMap<ClassName, Version>;

/**
 * Canonical sha256 of a Manifest.
 *
 * The serializer sorts entries lexicographically by class name and
 * emits a plain JSON object so the same map yields the same digest
 * regardless of insertion order. Both client and server compute
 * this from the same source, so it must remain deterministic and
 * byte-identical across implementations.
 */
export function manifestSha256(m: Manifest): string {
  const entries: [string, string][] = [];
  for (const [k, v] of m) entries.push([k as string, v as string]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const obj: Record<string, string> = {};
  for (const [k, v] of entries) obj[k] = v;
  const canonical = JSON.stringify(obj);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Build a Manifest from a plain object, branding the keys/values. */
export function manifestFromEntries(entries: Iterable<readonly [string, string]>): Manifest {
  const m = new Map<ClassName, Version>();
  for (const [k, v] of entries) {
    m.set(k as ClassName, v as Version);
  }
  return m;
}
