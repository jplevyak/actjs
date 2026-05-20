/**
 * Class loader.
 *
 * Fetches TypeScript source from the storage driver, transpiles it
 * via the TypeScript compiler API, wraps the result as the body of
 * `async function(actjs) { ... }`, evaluates with {@link CLASS_KIT}
 * as the parameter, and returns the resulting constructor.
 *
 * Compiled modules are cached by `sha256(source)` so two versions
 * with byte-identical bytes share an entry. Eviction is LRU once
 * the cap is exceeded, but a sha with any live references is
 * never evicted — guards against churn during rolling activations.
 */
import ts from 'typescript';

import type { Actor } from '../actor.js';
import type { ClassVersionRecord, StorageDriver } from '../storage/driver.js';
import type { ClassName, Version } from '../types/ids.js';

import { CLASS_KIT, type ClassKit } from './class-kit.js';

/* ----------------------------------------------------------- Types */

export type ActorCtor = new () => Actor;

export interface LoaderOptions {
  /** Maximum compiled modules cached at once. Default 256. */
  readonly maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 256;

export class LoaderError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'LoaderError';
    this.code = code;
  }
}

export class ClassSourceNotFound extends LoaderError {
  constructor(name: ClassName, version: Version) {
    super(`class source not found: ${name as string}@${version as string}`, 'ClassSourceNotFound');
  }
}

export class ClassVersionExpired extends LoaderError {
  constructor(name: ClassName, version: Version, graceUntilMs: number) {
    super(
      `class ${name as string}@${version as string} is past its grace window ` +
        `(${new Date(graceUntilMs).toISOString()}); refusing to load.`,
      'ClassVersionExpired',
    );
  }
}

export class CompileError extends LoaderError {
  readonly diagnostics: readonly string[];
  constructor(name: ClassName, version: Version, diagnostics: readonly string[]) {
    super(
      `compile failed for ${name as string}@${version as string}: ` + diagnostics.join('; '),
      'CompileError',
    );
    this.diagnostics = diagnostics;
  }
}

/* ----------------------------------------------------------- Impl */

interface CacheEntry {
  readonly sha: string;
  readonly ctor: ActorCtor;
  /** Wall-clock of last access; cheap LRU surrogate. */
  lastUsedAt: number;
  /** Number of active references (from live actor hosts). */
  refCount: number;
}

const AsyncFunctionCtor = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (kit: ClassKit) => Promise<unknown>;

export class ClassLoader {
  private readonly bySha = new Map<string, CacheEntry>();
  private readonly maxEntries: number;

  /** Test seam — counts compilations (cache misses). */
  compilations = 0n;

  constructor(
    private readonly driver: StorageDriver,
    options: LoaderOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * Load a class constructor for `(name, version)`. Subsequent calls
   * for the same content sha are O(1) cache hits.
   *
   * The returned constructor produces instances whose `state` /
   * `actor_id` / `actjs` fields are populated by the ActorHost; the
   * loader itself never instantiates.
   */
  async load(name: ClassName, version: Version): Promise<ActorCtor> {
    const record = await this.lookupRecord(name, version);
    if (!record) throw new ClassSourceNotFound(name, version);
    // Grace-window enforcement: a version past its `grace_until` is
    // refused even if its source still exists. The pin middleware
    // returns 410 before reaching here; this is the runtime backstop
    // for direct activations (Phase 3 manual register paths).
    if (record.graceUntil !== undefined && record.graceUntil <= Date.now()) {
      throw new ClassVersionExpired(name, version, record.graceUntil);
    }

    const cached = this.bySha.get(record.sourceSha256);
    if (cached) {
      cached.lastUsedAt = Date.now();
      return cached.ctor;
    }

    const sourceBuf = await this.driver.getClassSource(name, version);
    if (!sourceBuf) throw new ClassSourceNotFound(name, version);

    const ctor = await this.compileAndEvaluate(name, version, sourceBuf.toString('utf8'));
    this.cachePut(record.sourceSha256, ctor);
    return ctor;
  }

  /**
   * Mark a sha as in-use. While refCount > 0 the entry is excluded
   * from LRU eviction.
   */
  acquire(sha: string): void {
    const entry = this.bySha.get(sha);
    if (entry) entry.refCount++;
  }

  /** Decrement the refCount; safe to call even if the entry is gone. */
  release(sha: string): void {
    const entry = this.bySha.get(sha);
    if (!entry) return;
    if (entry.refCount > 0) entry.refCount--;
  }

  /** Number of cached entries. */
  size(): number {
    return this.bySha.size;
  }

  /** Test seam: look up the sha for a (name, version) without compiling. */
  async sha256For(name: ClassName, version: Version): Promise<string | null> {
    const record = await this.lookupRecord(name, version);
    return record?.sourceSha256 ?? null;
  }

  /* ------------------------------------------------------ Internal */

  private async lookupRecord(
    name: ClassName,
    version: Version,
  ): Promise<ClassVersionRecord | null> {
    const versions = await this.driver.listClassVersions(name);
    return versions.find((v) => (v.version as string) === (version as string)) ?? null;
  }

  private async compileAndEvaluate(
    name: ClassName,
    version: Version,
    source: string,
  ): Promise<ActorCtor> {
    this.compilations++;
    const { outputText, diagnostics } = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        // We deliberately keep emitted decorators (stage-3) intact; the
        // host bridge re-uses the framework's @handler decorator.
        experimentalDecorators: false,
        useDefineForClassFields: true,
        // No emit for `.d.ts` — we only need the JS.
        declaration: false,
        // The source includes `return ClassName;` at the top level so
        // we need to be permissive about that pattern.
        allowReturnOutsideFunction: true,
        // Strip type-only imports without translating them; the source
        // contract forbids real imports anyway.
        verbatimModuleSyntax: false,
      },
      fileName: `${name as string}@${version as string}.ts`,
      reportDiagnostics: true,
    });
    const msgs = (diagnostics ?? [])
      .filter((d) => d.category === ts.DiagnosticCategory.Error)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    if (msgs.length > 0) throw new CompileError(name, version, msgs);

    let result: unknown;
    try {
      const fn = new AsyncFunctionCtor('actjs', outputText);
      result = await fn(CLASS_KIT);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CompileError(name, version, [`module evaluation: ${msg}`]);
    }
    if (typeof result !== 'function') {
      throw new CompileError(name, version, [
        `class source must return a constructor; got ${typeof result}`,
      ]);
    }
    return result as ActorCtor;
  }

  private cachePut(sha: string, ctor: ActorCtor): void {
    this.bySha.set(sha, {
      sha,
      ctor,
      lastUsedAt: Date.now(),
      refCount: 0,
    });
    this.maybeEvict(sha);
  }

  private maybeEvict(justAdded?: string): void {
    if (this.bySha.size <= this.maxEntries) return;
    // Find the least-recently-used entry with refCount === 0, skipping
    // the just-added entry (otherwise a hot miss with one refcount-held
    // entry would evict its own insertion).
    let oldest: CacheEntry | null = null;
    for (const e of this.bySha.values()) {
      if (e.refCount > 0) continue;
      if (e.sha === justAdded) continue;
      if (!oldest || e.lastUsedAt < oldest.lastUsedAt) oldest = e;
    }
    if (oldest) this.bySha.delete(oldest.sha);
    // If every other entry has refCount > 0, we exceed cap. That's
    // intentional: a refcount-held entry is never evicted. Operators see
    // this in the size() metric and tune `maxEntries` accordingly.
  }
}
