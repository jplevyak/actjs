/**
 * Per-class incremental cache.
 *
 * `.actctl/last-sha.json` records the manifest sha of the most
 * recent successful generation; if the new manifest sha matches and
 * `--force` is not set, codegen exits fast without re-extracting
 * anything. `.actctl/classes.json` records `{ className → sourceSha }`
 * so per-class extraction can be skipped when only some classes
 * changed.
 *
 * The cache is best-effort: if the file is missing or unparseable
 * codegen runs from scratch. There is no corruption recovery beyond
 * "delete `.actctl/` and re-run".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface CacheState {
  /** Manifest sha of the last successful run. */
  readonly manifestSha: string;
  /** Per-class source sha snapshot for the last run. */
  readonly classes: Readonly<Record<string, string>>;
  /** Schema version — bump if the cache layout changes. */
  readonly schemaVersion: number;
}

const SCHEMA_VERSION = 1;
const LAST_SHA_FILE = 'last-sha.json';

export class Cache {
  constructor(private readonly dir: string) {}

  read(): CacheState | null {
    const file = join(this.dir, LAST_SHA_FILE);
    if (!existsSync(file)) return null;
    try {
      const text = readFileSync(file, 'utf8');
      const parsed = JSON.parse(text) as CacheState;
      if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  write(state: Omit<CacheState, 'schemaVersion'>): void {
    mkdirSync(this.dir, { recursive: true });
    const full: CacheState = { ...state, schemaVersion: SCHEMA_VERSION };
    writeFileSync(join(this.dir, LAST_SHA_FILE), JSON.stringify(full, null, 2));
  }

  static at(rootDir: string): Cache {
    return new Cache(join(rootDir, '.actctl'));
  }
}

export function defaultCacheDir(rootDir: string): string {
  return join(rootDir, '.actctl');
}

export function ensureCacheDir(rootDir: string): string {
  const dir = defaultCacheDir(rootDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    // Auto-add to .gitignore at the project root, if a sibling
    // .gitignore exists. Operators typically don't want a committed
    // cache; if they do, they can remove the line.
    const gi = join(dirname(dir), '.gitignore');
    if (existsSync(gi)) {
      try {
        const content = readFileSync(gi, 'utf8');
        if (!/^\.actctl\/$/m.test(content)) {
          writeFileSync(gi, `${content.endsWith('\n') ? content : content + '\n'}.actctl/\n`);
        }
      } catch {
        // best-effort
      }
    }
  }
  return dir;
}
