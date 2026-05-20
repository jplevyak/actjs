/**
 * actctl codegen pipeline tests.
 *
 * Covers: snapshot of emitted .d.ts/manifest/runtime against the
 * committed fixture, per-class source sha stability, --check drift
 * detection, incremental skip, and HTTP loader against a mock.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emit, extractClass, httpLoader, localLoader, run } from '../../src/codegen/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures');
const CLASSES_DIR = join(FIXTURE_DIR, 'classes');
const EXPECTED_DTS = readFileSync(join(FIXTURE_DIR, 'expected.d.ts'), 'utf8');
const EXPECTED_MANIFEST = readFileSync(join(FIXTURE_DIR, 'expected.manifest.json'), 'utf8');
const EXPECTED_RUNTIME = readFileSync(join(FIXTURE_DIR, 'expected.runtime.js'), 'utf8');

let workDir: string;
beforeEach(() => {
  workDir = join(tmpdir(), `actctl-codegen-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(workDir, { recursive: true });
});
afterEach(() => {
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

describe('codegen / extract', () => {
  it('extracts SWM handlers and state from Cart', () => {
    const source = readFileSync(join(CLASSES_DIR, 'Cart.ts'), 'utf8');
    const extracted = extractClass({ className: 'Cart', version: '1.2.0', source });
    expect(extracted.eventSourced).toBe(false);
    expect(extracted.handlers.map((h) => h.name)).toEqual(['addItem', 'clear']);
    const addItem = extracted.handlers.find((h) => h.name === 'addItem')!;
    expect(addItem.argsType).toBe('{ sku: string; qty: number }');
    expect(addItem.returnType).toBe('{ total: number }');
  });

  it('extracts ES events, reduce, and handler return as Event[]', () => {
    const source = readFileSync(join(CLASSES_DIR, 'Ledger.ts'), 'utf8');
    const extracted = extractClass({ className: 'Ledger', version: '2.0.0', source });
    expect(extracted.eventSourced).toBe(true);
    expect(extracted.eventType).toMatch(/credit/);
    expect(extracted.reduceBody).not.toBeNull();
    const credit = extracted.handlers.find((h) => h.name === 'credit')!;
    expect(credit.esEventReturn).toBe(true);
  });

  it('produces a stable source sha for identical bytes', () => {
    const source = readFileSync(join(CLASSES_DIR, 'Cart.ts'), 'utf8');
    const a = extractClass({ className: 'Cart', version: '1.2.0', source });
    const b = extractClass({ className: 'Cart', version: '1.2.0', source });
    expect(a.sourceSha256).toBe(b.sourceSha256);
    expect(a.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('codegen / emit snapshot', () => {
  it('emits the committed .d.ts byte-for-byte', async () => {
    const result = await run({
      source: localLoader({ dir: CLASSES_DIR }),
      outDir: workDir,
      rootDir: workDir,
    });
    expect(result.status).toBe('wrote');
    expect(readFileSync(join(workDir, 'index.d.ts'), 'utf8')).toBe(EXPECTED_DTS);
    expect(readFileSync(join(workDir, 'manifest.json'), 'utf8')).toBe(EXPECTED_MANIFEST);
    expect(readFileSync(join(workDir, 'index.runtime.js'), 'utf8')).toBe(EXPECTED_RUNTIME);
  });

  it('manifest sha embedded in .d.ts matches manifest.json', async () => {
    await run({
      source: localLoader({ dir: CLASSES_DIR }),
      outDir: workDir,
      rootDir: workDir,
    });
    const dts = readFileSync(join(workDir, 'index.d.ts'), 'utf8');
    const manifest = JSON.parse(readFileSync(join(workDir, 'manifest.json'), 'utf8')) as {
      sha256: string;
    };
    expect(dts).toContain(`'${manifest.sha256}'`);
  });
});

describe('codegen / --check', () => {
  it('reports clean when output matches', async () => {
    await run({
      source: localLoader({ dir: CLASSES_DIR }),
      outDir: workDir,
      rootDir: workDir,
    });
    const result = await run({
      source: localLoader({ dir: CLASSES_DIR }),
      outDir: workDir,
      rootDir: workDir,
      check: true,
    });
    expect(result.status).toBe('check-clean');
    expect(result.diff).toBeUndefined();
  });

  it('reports drift when a handler is removed', async () => {
    // Seed the output dir with the canonical fixture.
    writeFileSync(join(workDir, 'index.d.ts'), EXPECTED_DTS);
    writeFileSync(join(workDir, 'manifest.json'), EXPECTED_MANIFEST);
    writeFileSync(join(workDir, 'index.runtime.js'), EXPECTED_RUNTIME);

    // Modify the source: drop the `clear` handler.
    const modified = readFileSync(join(CLASSES_DIR, 'Cart.ts'), 'utf8').replace(
      /@handler\('clear'\)[\s\S]*?clear\([^)]*\)[^{]*\{[\s\S]*?\}\s*/m,
      '',
    );
    const modifiedDir = join(workDir, '__modified-classes');
    mkdirSync(modifiedDir, { recursive: true });
    writeFileSync(join(modifiedDir, 'Cart.ts'), modified);
    writeFileSync(join(modifiedDir, 'Cart.meta.json'), '{ "version": "1.2.0" }\n');
    writeFileSync(
      join(modifiedDir, 'Ledger.ts'),
      readFileSync(join(CLASSES_DIR, 'Ledger.ts'), 'utf8'),
    );
    writeFileSync(join(modifiedDir, 'Ledger.meta.json'), '{ "version": "2.0.0" }\n');

    const result = await run({
      source: localLoader({ dir: modifiedDir }),
      outDir: workDir,
      rootDir: workDir,
      check: true,
    });
    expect(result.status).toBe('check-drift');
    expect(result.diff).toContain('-  clear(args:');
  });
});

describe('codegen / incremental', () => {
  it('skips re-generation when source bytes are unchanged', async () => {
    const first = await run({
      source: localLoader({ dir: CLASSES_DIR }),
      outDir: workDir,
      rootDir: workDir,
    });
    expect(first.status).toBe('wrote');
    const second = await run({
      source: localLoader({ dir: CLASSES_DIR }),
      outDir: workDir,
      rootDir: workDir,
    });
    expect(second.status).toBe('skipped');
  });

  it('regenerates with --force even when cache is fresh', async () => {
    await run({
      source: localLoader({ dir: CLASSES_DIR }),
      outDir: workDir,
      rootDir: workDir,
    });
    const second = await run({
      source: localLoader({ dir: CLASSES_DIR }),
      outDir: workDir,
      rootDir: workDir,
      force: true,
    });
    expect(second.status).toBe('wrote');
  });

  it('cached re-run is dramatically faster than the initial generation', async () => {
    const first = process.hrtime.bigint();
    await run({
      source: localLoader({ dir: CLASSES_DIR }),
      outDir: workDir,
      rootDir: workDir,
    });
    const afterFirst = process.hrtime.bigint();

    const second = process.hrtime.bigint();
    const result = await run({
      source: localLoader({ dir: CLASSES_DIR }),
      outDir: workDir,
      rootDir: workDir,
    });
    const afterSecond = process.hrtime.bigint();

    expect(result.status).toBe('skipped');
    // The cached path still does source IO + sha — relative speedup
    // is the actual signal. On warm CI the skip is typically 5-50×
    // faster; we assert "at least 2× faster" to avoid flakes.
    const firstMs = Number(afterFirst - first) / 1_000_000;
    const secondMs = Number(afterSecond - second) / 1_000_000;
    expect(secondMs).toBeLessThan(firstMs / 2);
  });

  it('regenerates when a class source changes', async () => {
    const local = join(workDir, 'classes');
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, 'Cart.ts'), readFileSync(join(CLASSES_DIR, 'Cart.ts'), 'utf8'));
    writeFileSync(join(local, 'Cart.meta.json'), '{ "version": "1.2.0" }\n');

    await run({
      source: localLoader({ dir: local }),
      outDir: workDir,
      rootDir: workDir,
    });
    // Mutate the source.
    writeFileSync(
      join(local, 'Cart.ts'),
      `class Cart extends actjs.Actor<{ items: number[] }> {\n  @handler('inc')\n  inc(args: { by: number }): number {\n    return args.by;\n  }\n}\n`,
    );
    const result = await run({
      source: localLoader({ dir: local }),
      outDir: workDir,
      rootDir: workDir,
    });
    expect(result.status).toBe('wrote');
  });
});

describe('codegen / http loader', () => {
  it('walks /v1/classes and downloads source', async () => {
    const calls: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      calls.push(url);
      if (url.endsWith('/v1/classes')) {
        return new Response(JSON.stringify({ classes: ['Cart'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/v1/classes/Cart/versions')) {
        return new Response(JSON.stringify({ versions: [{ name: 'Cart', version: '1.0.0' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/v1/classes/Cart/versions/1.0.0/source')) {
        return new Response(readFileSync(join(CLASSES_DIR, 'Cart.ts'), 'utf8'), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }
      return new Response('not found', { status: 404 });
    };
    const loader = httpLoader({
      baseUrl: 'http://srv.test',
      target: 'prod',
      token: 'abc',
      fetchImpl: mockFetch,
    });
    const inputs = await loader.load();
    expect(inputs.map((i) => i.className)).toEqual(['Cart']);
    expect(inputs[0]!.version).toBe('1.0.0');
    expect(calls[0]).toBe('http://srv.test/v1/classes');
  });

  it('skips classes that are entirely deprecated', async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/v1/classes')) {
        return new Response(JSON.stringify({ classes: ['Dead'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/v1/classes/Dead/versions')) {
        return new Response(
          JSON.stringify({
            versions: [{ name: 'Dead', version: '1.0.0', deprecatedAt: 1 }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    };
    const loader = httpLoader({
      baseUrl: 'http://srv.test',
      target: 'prod',
      fetchImpl: mockFetch,
    });
    const inputs = await loader.load();
    expect(inputs).toEqual([]);
  });
});

describe('codegen / emit determinism', () => {
  it('produces byte-identical output for the same input', () => {
    const cart = extractClass({
      className: 'Cart',
      version: '1.2.0',
      source: readFileSync(join(CLASSES_DIR, 'Cart.ts'), 'utf8'),
    });
    const a = emit([cart]);
    const b = emit([cart]);
    expect(a.dts).toBe(b.dts);
    expect(a.manifestJson).toBe(b.manifestJson);
    expect(a.runtimeJs).toBe(b.runtimeJs);
  });

  it('sorts classes by name regardless of input order', () => {
    const cart = extractClass({
      className: 'Cart',
      version: '1.2.0',
      source: readFileSync(join(CLASSES_DIR, 'Cart.ts'), 'utf8'),
    });
    const ledger = extractClass({
      className: 'Ledger',
      version: '2.0.0',
      source: readFileSync(join(CLASSES_DIR, 'Ledger.ts'), 'utf8'),
    });
    const a = emit([cart, ledger]);
    const b = emit([ledger, cart]);
    expect(a.dts).toBe(b.dts);
  });
});
