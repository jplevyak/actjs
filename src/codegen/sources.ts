/**
 * Source acquisition for codegen.
 *
 * Two source kinds are supported:
 *
 *   - `local:<dir>`   Reads every `*.ts` file in `<dir>` and treats
 *                     the basename as the class name. The version
 *                     defaults to `0.0.0-local` unless a sibling
 *                     `<name>.meta.json` supplies one.
 *
 *   - `http:<url>`    Hits the running actjs server. For each class
 *                     listed by `GET /v1/classes`, picks the latest
 *                     non-deprecated version per the target env, and
 *                     downloads the source via `GET /v1/classes/:n/
 *                     versions/:v/source`.
 *
 *  Skipped for this phase: direct Postgres queries. The server URL
 *  path is the supported production flow; reading PG directly is a
 *  follow-up for ops tooling that needs offline access.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

import type { CodegenInput } from './types.js';

export interface SourceLoader {
  load(): Promise<readonly CodegenInput[]>;
}

export type Target = 'dev' | 'staging' | 'prod';

/* ------------------------------------------------------------ Local */

export interface LocalLoaderOptions {
  readonly dir: string;
}

export function localLoader(options: LocalLoaderOptions): SourceLoader {
  return {
    load: () => Promise.resolve(loadLocal(options.dir)),
  };
}

function loadLocal(dir: string): CodegenInput[] {
  const out: CodegenInput[] = [];
  const entries = readdirSync(dir);
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (!st.isFile()) continue;
    if (extname(name) !== '.ts') continue;
    const className = name.slice(0, -3);
    const source = readFileSync(full, 'utf8');
    const meta = readMeta(join(dir, `${className}.meta.json`));
    out.push({
      className,
      source,
      version: meta?.version ?? '0.0.0-local',
    });
  }
  out.sort((a, b) => (a.className < b.className ? -1 : a.className > b.className ? 1 : 0));
  return out;
}

function readMeta(path: string): { version?: string } | null {
  try {
    const data = readFileSync(path, 'utf8');
    return JSON.parse(data) as { version?: string };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ HTTP */

export interface HttpLoaderOptions {
  readonly baseUrl: string;
  /** Bearer token sent on every request. Required for production. */
  readonly token?: string;
  /** Override fetch for tests. */
  readonly fetchImpl?: typeof fetch;
  readonly target: Target;
}

export function httpLoader(options: HttpLoaderOptions): SourceLoader {
  return {
    load: () => loadHttp(options),
  };
}

interface VersionRecord {
  name: string;
  version: string;
  deprecatedAt?: number;
  graceUntil?: number;
}

async function loadHttp(options: HttpLoaderOptions): Promise<CodegenInput[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;

  const indexRes = await fetchImpl(`${options.baseUrl}/v1/classes`, { headers });
  if (!indexRes.ok) {
    // Phase 5.1's `GET /v1/classes` returns 501; require an explicit
    // class list via `?class=Foo&class=Bar` until that ships.
    throw new HttpLoaderError(
      `GET /v1/classes is not available (${indexRes.status}). Pass --class to enumerate.`,
    );
  }
  const indexJson = (await indexRes.json()) as { classes: readonly string[] };

  const out: CodegenInput[] = [];
  for (const className of indexJson.classes) {
    const listRes = await fetchImpl(
      `${options.baseUrl}/v1/classes/${encodeURIComponent(className)}/versions`,
      { headers },
    );
    if (!listRes.ok) {
      throw new HttpLoaderError(
        `failed to list versions for ${className}: ${listRes.status} ${listRes.statusText}`,
      );
    }
    const list = (await listRes.json()) as { versions: VersionRecord[] };
    const version = pickLatestNonDeprecated(list.versions);
    if (!version) continue;
    const sourceRes = await fetchImpl(
      `${options.baseUrl}/v1/classes/${encodeURIComponent(className)}/versions/${encodeURIComponent(version)}/source`,
      { headers },
    );
    if (!sourceRes.ok) {
      throw new HttpLoaderError(
        `failed to fetch source for ${className}@${version}: ${sourceRes.status}`,
      );
    }
    const source = await sourceRes.text();
    out.push({ className, version, source });
  }
  out.sort((a, b) => (a.className < b.className ? -1 : a.className > b.className ? 1 : 0));
  return out;
}

function pickLatestNonDeprecated(versions: readonly VersionRecord[]): string | null {
  // The server doesn't reorder; we sort by semver descending.
  const live = versions.filter((v) => v.deprecatedAt === undefined);
  if (live.length === 0) return null;
  live.sort((a, b) => semverCompare(b.version, a.version));
  return live[0]!.version;
}

function semverCompare(a: string, b: string): number {
  // Lightweight semver comparator — fine for sorting; rich semantics
  // are the registry's job. Splits on `.`/`-` and compares numerically
  // where possible.
  const segA = a.split(/[.+-]/);
  const segB = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(segA.length, segB.length); i++) {
    const x = segA[i] ?? '0';
    const y = segB[i] ?? '0';
    const xi = Number(x);
    const yi = Number(y);
    if (Number.isFinite(xi) && Number.isFinite(yi)) {
      if (xi !== yi) return xi - yi;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export class HttpLoaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpLoaderError';
  }
}
