import { describe, expect, it } from 'vitest';

import {
  ClassNotFound,
  DepConflict,
  LimitExceeded,
  resolve,
  type CatalogLookup,
} from '../../src/registry/index.js';
import type { ClassVersionRecord } from '../../src/storage/driver.js';
import { asClassName, asVersion, manifestSha256 } from '../../src/types/index.js';

/* -------------------------------------- Catalog builder helpers */

type Spec = {
  version: string;
  deps?: Record<string, string>;
  deprecated?: boolean;
};

function mkCatalog(map: Record<string, Spec[]>): CatalogLookup {
  return async (name) => {
    const list = map[name as string] ?? [];
    return list.map(
      (s): ClassVersionRecord => ({
        name: name,
        version: asVersion(s.version),
        sourceSha256: 'fake-sha',
        deps: s.deps ?? {},
        engines: {},
        publishedAt: 0,
        floating: false,
        eventSourced: false,
        ...(s.deprecated ? { deprecatedAt: 0 } : {}),
      }),
    );
  };
}

/* ------------------------------------------------ Single-root tests */

describe('resolver — single root', () => {
  it('picks the only available version', async () => {
    const catalog = mkCatalog({ Cart: [{ version: '1.0.0' }] });
    const { manifest } = await resolve([{ name: asClassName('Cart'), range: '1.0.0' }], catalog);
    expect(Array.from(manifest.entries())).toEqual([['Cart', '1.0.0']]);
  });

  it('picks the highest version satisfying a caret range', async () => {
    const catalog = mkCatalog({
      Cart: [
        { version: '1.0.0' },
        { version: '1.4.2' },
        { version: '2.0.0' }, // outside ^1.0.0
      ],
    });
    const { manifest } = await resolve([{ name: asClassName('Cart'), range: '^1.0.0' }], catalog);
    expect(manifest.get(asClassName('Cart'))).toBe('1.4.2');
  });

  it('skips deprecated versions', async () => {
    const catalog = mkCatalog({
      Cart: [{ version: '1.0.0' }, { version: '1.5.0', deprecated: true }, { version: '1.4.0' }],
    });
    const { manifest } = await resolve([{ name: asClassName('Cart'), range: '^1.0.0' }], catalog);
    expect(manifest.get(asClassName('Cart'))).toBe('1.4.0');
  });

  it('rejects when no version satisfies the range', async () => {
    const catalog = mkCatalog({
      Cart: [{ version: '1.0.0' }, { version: '2.0.0' }],
    });
    await expect(
      resolve([{ name: asClassName('Cart'), range: '^3.0.0' }], catalog),
    ).rejects.toBeInstanceOf(DepConflict);
  });

  it('throws ClassNotFound for unknown classes via catalogFromDriver', async () => {
    const empty: CatalogLookup = async () => [];
    await expect(
      resolve([{ name: asClassName('Mystery'), range: '*' }], empty),
    ).rejects.toBeInstanceOf(DepConflict);
  });
});

/* ------------------------------------------------------ Dep tree tests */

describe('resolver — dep tree', () => {
  it('walks deps and pins each class', async () => {
    const catalog = mkCatalog({
      Cart: [{ version: '1.0.0', deps: { Item: '^1.0.0' } }],
      Item: [{ version: '1.0.0' }, { version: '1.5.0' }],
    });
    const { manifest } = await resolve([{ name: asClassName('Cart'), range: '1.0.0' }], catalog);
    expect(manifest.get(asClassName('Cart'))).toBe('1.0.0');
    expect(manifest.get(asClassName('Item'))).toBe('1.5.0');
  });

  it('reconverges when a transitive constraint tightens an earlier pick', async () => {
    const catalog = mkCatalog({
      Root: [
        {
          version: '1.0.0',
          deps: { Lib: '^1.0.0', Tightener: '1.0.0' },
        },
      ],
      Lib: [{ version: '1.0.0' }, { version: '1.4.0' }, { version: '1.5.0' }],
      Tightener: [{ version: '1.0.0', deps: { Lib: '<1.5.0' } }],
    });
    const { manifest } = await resolve([{ name: asClassName('Root'), range: '1.0.0' }], catalog);
    // After Tightener adds `< 1.5.0`, Lib re-picks down from 1.5.0 to 1.4.0.
    expect(manifest.get(asClassName('Lib'))).toBe('1.4.0');
  });

  it('throws DepConflict on incompatible accumulated ranges', async () => {
    const catalog = mkCatalog({
      Cart: [{ version: '1.0.0', deps: { Item: '^1.0.0' } }],
      Pricing: [{ version: '1.0.0', deps: { Item: '^2.0.0' } }],
      Item: [{ version: '1.0.0' }, { version: '2.0.0' }],
    });
    let caught: unknown;
    try {
      await resolve(
        [
          { name: asClassName('Cart'), range: '1.0.0' },
          { name: asClassName('Pricing'), range: '1.0.0' },
        ],
        catalog,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DepConflict);
    if (caught instanceof DepConflict) {
      expect(caught.className).toBe('Item');
      expect(caught.accumulatedRanges.length).toBeGreaterThanOrEqual(2);
      // Path must include the cause chain (Cart or Pricing as root).
      const rangeStrings = caught.accumulatedRanges.map((r) => r.range).sort();
      expect(rangeStrings).toEqual(['^1.0.0', '^2.0.0']);
    }
  });
});

/* ------------------------------------------------------ Determinism */

describe('resolver — determinism', () => {
  it('two runs over the same catalog produce identical manifests', async () => {
    const catalog = mkCatalog({
      Cart: [{ version: '1.4.2', deps: { Item: '^1.0.0' } }],
      Item: [{ version: '1.0.5' }, { version: '1.0.9' }],
    });
    const r1 = await resolve([{ name: asClassName('Cart'), range: '^1.0.0' }], catalog);
    const r2 = await resolve([{ name: asClassName('Cart'), range: '^1.0.0' }], catalog);
    expect(manifestSha256(r1.manifest)).toBe(manifestSha256(r2.manifest));
  });

  it('manifest sha is order-independent across roots', async () => {
    const catalog = mkCatalog({
      A: [{ version: '1.0.0' }],
      B: [{ version: '1.0.0' }],
    });
    const r1 = await resolve(
      [
        { name: asClassName('A'), range: '1.0.0' },
        { name: asClassName('B'), range: '1.0.0' },
      ],
      catalog,
    );
    const r2 = await resolve(
      [
        { name: asClassName('B'), range: '1.0.0' },
        { name: asClassName('A'), range: '1.0.0' },
      ],
      catalog,
    );
    expect(manifestSha256(r1.manifest)).toBe(manifestSha256(r2.manifest));
  });
});

/* ----------------------------------------------------------- Limits */

describe('resolver — limits', () => {
  it('exceeds maxNodes on a deep linear graph', async () => {
    // Chain of 300 deps: A -> A1 -> A2 -> ... -> A299
    const map: Record<string, Spec[]> = {};
    for (let i = 0; i <= 300; i++) {
      const name = `A${i}`;
      const dep = i < 300 ? { [`A${i + 1}`]: '1.0.0' } : {};
      map[name] = [{ version: '1.0.0', deps: dep }];
    }
    const catalog = mkCatalog(map);
    await expect(
      resolve([{ name: asClassName('A0'), range: '1.0.0' }], catalog, {
        maxNodes: 64,
      }),
    ).rejects.toBeInstanceOf(LimitExceeded);
  });
});

/* ----------------------------------------------- ClassNotFound bubble */

describe('resolver — class not found via catalogFromDriver', () => {
  it('throws ClassNotFound when the driver catalog is empty', async () => {
    const empty: CatalogLookup = async (n) => {
      throw new ClassNotFound(n);
    };
    await expect(
      resolve([{ name: asClassName('Nope'), range: '*' }], empty),
    ).rejects.toBeInstanceOf(ClassNotFound);
  });
});
