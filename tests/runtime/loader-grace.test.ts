import { describe, expect, it } from 'vitest';

import { publishClass } from '../../src/registry/index.js';
import { ClassLoader, ClassVersionExpired } from '../../src/runtime/loader.js';
import { MemoryStorageDriver } from '../../src/storage/memory.js';
import { asClassName, asVersion } from '../../src/types/index.js';

const SOURCE = `
class Cart extends actjs.Actor {
  constructor() { super(); }
}
return Cart;
`;

describe('ClassLoader — grace window', () => {
  it('refuses to load a class version past its grace_until', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    await publishClass(driver, {
      name: asClassName('Cart'),
      version: asVersion('1.0.0'),
      source: SOURCE,
    });
    // Set graceUntil into the past — version is expired.
    await driver.deprecateClassVersion(asClassName('Cart'), asVersion('1.0.0'), Date.now() - 1000);
    const loader = new ClassLoader(driver);
    await expect(loader.load(asClassName('Cart'), asVersion('1.0.0'))).rejects.toBeInstanceOf(
      ClassVersionExpired,
    );
    await driver.close();
  });

  it('still loads a deprecated-but-in-grace version', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    await publishClass(driver, {
      name: asClassName('Cart'),
      version: asVersion('1.0.0'),
      source: SOURCE,
    });
    await driver.deprecateClassVersion(
      asClassName('Cart'),
      asVersion('1.0.0'),
      Date.now() + 60_000,
    );
    const loader = new ClassLoader(driver);
    const ctor = await loader.load(asClassName('Cart'), asVersion('1.0.0'));
    expect(typeof ctor).toBe('function');
    await driver.close();
  });
});
