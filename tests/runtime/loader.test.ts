import { describe, expect, it } from 'vitest';

import { publishClass } from '../../src/registry/index.js';
import { ClassLoader, CompileError } from '../../src/runtime/loader.js';
import { MemoryStorageDriver } from '../../src/storage/memory.js';
import { Actor } from '../../src/actor.js';
import { asClassName, asVersion } from '../../src/types/index.js';

const sourceV1 = `
class Cart extends actjs.Actor {
  constructor() {
    super();
  }
}
return Cart;
`;

const sourceV2 = `
class Cart extends actjs.Actor {
  constructor() {
    super();
  }
  greet() { return 'v2'; }
}
return Cart;
`;

async function seed(driver: MemoryStorageDriver, name: string, version: string, source: string) {
  await publishClass(driver, {
    name: asClassName(name),
    version: asVersion(version),
    source,
  });
}

describe('ClassLoader', () => {
  it('loads a published class, instances extend Actor', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    await seed(driver, 'Cart', '1.0.0', sourceV1);

    const loader = new ClassLoader(driver);
    const ctor = await loader.load(asClassName('Cart'), asVersion('1.0.0'));
    const instance = new ctor();
    expect(instance).toBeInstanceOf(Actor);
    await driver.close();
  });

  it('caches by sha — repeat load returns the same constructor without recompiling', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    await seed(driver, 'Cart', '1.0.0', sourceV1);

    const loader = new ClassLoader(driver);
    const a = await loader.load(asClassName('Cart'), asVersion('1.0.0'));
    const compilesBefore = loader.compilations;
    const b = await loader.load(asClassName('Cart'), asVersion('1.0.0'));
    expect(b).toBe(a);
    expect(loader.compilations).toBe(compilesBefore);
    await driver.close();
  });

  it('two coexisting versions of the same class produce distinct constructors', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    await seed(driver, 'Cart', '1.0.0', sourceV1);
    await seed(driver, 'Cart', '2.0.0', sourceV2);

    const loader = new ClassLoader(driver);
    const v1 = await loader.load(asClassName('Cart'), asVersion('1.0.0'));
    const v2 = await loader.load(asClassName('Cart'), asVersion('2.0.0'));
    expect(v1).not.toBe(v2);
    expect(loader.compilations).toBe(2n);

    // The v2 instance has the new method.
    const i2 = new v2() as Actor & { greet: () => string };
    expect(i2.greet()).toBe('v2');

    // The v1 instance does not.
    const i1 = new v1() as Actor & { greet?: () => string };
    expect(i1.greet).toBeUndefined();

    await driver.close();
  });

  it('LRU evicts the oldest entry when over cap', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    await seed(driver, 'A', '1.0.0', sourceV1.replace(/Cart/g, 'A'));
    await seed(driver, 'B', '1.0.0', sourceV1.replace(/Cart/g, 'B'));
    await seed(driver, 'C', '1.0.0', sourceV1.replace(/Cart/g, 'C'));

    const loader = new ClassLoader(driver, { maxEntries: 2 });
    await loader.load(asClassName('A'), asVersion('1.0.0'));
    await loader.load(asClassName('B'), asVersion('1.0.0'));
    expect(loader.size()).toBe(2);
    await loader.load(asClassName('C'), asVersion('1.0.0'));
    expect(loader.size()).toBe(2);
    await driver.close();
  });

  it('refcount holds an entry past the cap', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    await seed(driver, 'A', '1.0.0', sourceV1.replace(/Cart/g, 'A'));
    await seed(driver, 'B', '1.0.0', sourceV1.replace(/Cart/g, 'B'));
    await seed(driver, 'C', '1.0.0', sourceV1.replace(/Cart/g, 'C'));

    const loader = new ClassLoader(driver, { maxEntries: 1 });
    await loader.load(asClassName('A'), asVersion('1.0.0'));
    const shaA = (await loader.sha256For(asClassName('A'), asVersion('1.0.0')))!;
    loader.acquire(shaA);

    await loader.load(asClassName('B'), asVersion('1.0.0'));
    // A is refcounted; size exceeds cap rather than evicting A.
    expect(loader.size()).toBeGreaterThanOrEqual(2);

    loader.release(shaA);
    await loader.load(asClassName('C'), asVersion('1.0.0'));
    // Now A is evictable.
    expect(loader.size()).toBeLessThanOrEqual(2);

    await driver.close();
  });

  it('rejects source that does not return a constructor', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    await seed(driver, 'Bad', '1.0.0', `const x = 42; return x;`);
    const loader = new ClassLoader(driver);
    await expect(loader.load(asClassName('Bad'), asVersion('1.0.0'))).rejects.toBeInstanceOf(
      CompileError,
    );
    await driver.close();
  });
});
