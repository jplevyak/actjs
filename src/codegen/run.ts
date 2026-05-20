/**
 * Top-level codegen driver.
 *
 * Stitches the source loader → extractor → emitter → cache pipeline.
 * Used by both the `actctl codegen` CLI and the in-process tests.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { Cache, ensureCacheDir } from './cache.js';
import { unifiedDiff } from './diff.js';
import { emit } from './emit.js';
import { extractClass } from './extract.js';
import type { SourceLoader } from './sources.js';
import type { CodegenInput, ExtractedClass } from './types.js';

export interface RunOptions {
  readonly source: SourceLoader;
  /** Output directory for `.d.ts` / `manifest.json` / `runtime.js`. */
  readonly outDir: string;
  /** Repo root for the `.actctl/` cache. Defaults to `outDir`. */
  readonly rootDir?: string;
  /** Ignore the cache. */
  readonly force?: boolean;
  /** Don't write; produce a unified diff against committed files. */
  readonly check?: boolean;
}

export interface RunResult {
  readonly status: 'wrote' | 'skipped' | 'check-clean' | 'check-drift';
  readonly manifestSha: string;
  readonly classes: readonly ExtractedClass[];
  readonly diff?: string;
  readonly warnings: readonly string[];
}

export async function run(options: RunOptions): Promise<RunResult> {
  const inputs = await options.source.load();
  const rootDir = options.rootDir ?? options.outDir;
  const cache = Cache.at(rootDir);

  // Fast-path: hash inputs and compare against the cache before
  // running the (relatively expensive) TS parse. If the per-class
  // shas all match and the output files are still on disk, the
  // committed output is already correct — bail out.
  const perClassSha = hashInputs(inputs);
  if (!options.check && !options.force) {
    const cached = cache.read();
    if (cached && shallowEqual(cached.classes, perClassSha) && outputFilesExist(options.outDir)) {
      return {
        status: 'skipped',
        manifestSha: cached.manifestSha,
        classes: [],
        warnings: [],
      };
    }
  }

  const classes = inputs.map((i) => extractClass(i));
  const result = emit(classes);
  const warnings = classes.flatMap((c) => c.warnings.map((w) => `${c.name}: ${w}`));

  if (options.check) {
    const drift = computeDrift(options.outDir, result);
    if (!drift) {
      return { status: 'check-clean', manifestSha: result.manifestSha, classes, warnings };
    }
    return {
      status: 'check-drift',
      manifestSha: result.manifestSha,
      classes,
      diff: drift,
      warnings,
    };
  }

  writeOutputs(options.outDir, result);
  ensureCacheDir(rootDir);
  cache.write({
    manifestSha: result.manifestSha,
    classes: Object.fromEntries(result.perClassSha),
  });
  return { status: 'wrote', manifestSha: result.manifestSha, classes, warnings };
}

function hashInputs(inputs: readonly CodegenInput[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of inputs) {
    out[i.className] = createHash('sha256').update(i.source, 'utf8').digest('hex');
  }
  return out;
}

/* --------------------------------------------------------- IO helpers */

function writeOutputs(outDir: string, result: ReturnType<typeof emit>): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.d.ts'), result.dts);
  writeFileSync(join(outDir, 'manifest.json'), result.manifestJson + '\n');
  writeFileSync(join(outDir, 'index.runtime.js'), result.runtimeJs);
}

function outputFilesExist(outDir: string): boolean {
  return (
    existsSync(join(outDir, 'index.d.ts')) &&
    existsSync(join(outDir, 'manifest.json')) &&
    existsSync(join(outDir, 'index.runtime.js'))
  );
}

function readIfExists(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function computeDrift(outDir: string, result: ReturnType<typeof emit>): string | null {
  const targets: { path: string; expected: string }[] = [
    { path: join(outDir, 'index.d.ts'), expected: result.dts },
    { path: join(outDir, 'manifest.json'), expected: result.manifestJson + '\n' },
    { path: join(outDir, 'index.runtime.js'), expected: result.runtimeJs },
  ];
  const diffs: string[] = [];
  for (const t of targets) {
    const committed = readIfExists(t.path);
    if (committed === t.expected) continue;
    diffs.push(unifiedDiff(committed, t.expected, `committed ${t.path}`, 'generated'));
  }
  return diffs.length === 0 ? null : diffs.join('\n');
}

function shallowEqual(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/* --------------------------------------------------------- Reexports */

export type { CodegenInput, ExtractedClass };
