import { describe, expect, it } from 'vitest';

import { publishClass } from '../../src/registry/index.js';
import { ManifestRegression } from '../../src/runtime/host.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { MemoryStorageDriver } from '../../src/storage/memory.js';
import { Actor } from '../../src/actor.js';
import { handler } from '../../src/handler.js';
import { asClassName, asVersion, mkActorId } from '../../src/types/index.js';

/* ----------------------- Inline test classes (TS imports OK in tests) */

class CartV1 extends Actor<{ items: number }> {
  override onInit(): void {
    this.state = { items: 0 };
  }
  @handler('add')
  add(args: { n: number }): void {
    this.state.items += args.n;
  }
  @handler('read')
  read(): number {
    return this.state.items;
  }
}

class CartV2 extends Actor<{ items: number; currency: string }> {
  override onInit(): void {
    this.state = { items: 0, currency: 'USD' };
  }
  @handler('add')
  add(args: { n: number }): void {
    this.state.items += args.n;
  }
  @handler('read')
  read(): { items: number; currency: string } {
    return this.state;
  }
  override migrate(prev: unknown): { items: number; currency: string } {
    const old = prev as { items: number };
    return { items: old.items, currency: 'USD' };
  }
}

/* ---------------- Source for the v1 class published via the registry */

// Published source uses an explicit `_handlers` registry. The
// @actjs.handler decorator works at compile time, but its stage-3
// emit inside the AsyncFunction loader is version-sensitive; the
// runtime reads `getHandlers(ctor)` which is just `ctor._handlers`,
// so direct assignment is a stable contract.
const cartV1Source = `
class Cart extends actjs.Actor {
  constructor() {
    super();
  }
  onInit() { this.state = { items: 0 }; }
  add(args) { this.state.items += args.n; }
  read() { return this.state.items; }
}
Cart._handlers = {
  add: Cart.prototype.add,
  read: Cart.prototype.read,
};
return Cart;
`;

/* ------------------------------------------------------------- Tests */

describe('Version policy', () => {
  it('sticky default loads the persisted older version via the registry', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const id = mkActorId();

    // Publish v1 source so the loader can find it.
    await publishClass(driver, {
      name: asClassName('Cart'),
      version: asVersion('1.0.0'),
      source: cartV1Source,
    });

    // Phase 1: run as v1, accumulate state.
    {
      const rt = new Runtime(driver);
      rt.register({
        name: asClassName('Cart'),
        version: asVersion('1.0.0'),
        ctor: CartV1,
        snapshotDebounceMs: 2,
      });
      await rt.tell(asClassName('Cart'), id, 'add', { n: 5 });
      await rt.drain();
      await rt.shutdown();
    }

    // Phase 2: register v2 (sticky default). The persisted snapshot still
    // says v1.0.0; the loader fetches the v1 source from the driver.
    {
      const rt = new Runtime(driver);
      rt.register({
        name: asClassName('Cart'),
        version: asVersion('2.0.0'),
        ctor: CartV2,
        snapshotDebounceMs: 2,
        // floating omitted → sticky default
      });
      // The loaded v1 class's `add` handler runs (not v2's).
      await rt.tell(asClassName('Cart'), id, 'add', { n: 3 });
      await rt.drain();

      // The snapshot stays at v1.0.0 because sticky never re-stamps the version.
      const snap = await driver.loadSnapshot<{ items: number }>(id);
      expect(snap!.version).toBe('1.0.0');
      expect(snap!.state.items).toBe(8);

      await rt.shutdown();
    }

    await driver.close();
  });

  it('floating: true runs the new ctor and migrates the snapshot', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const id = mkActorId();

    // Phase 1
    {
      const rt = new Runtime(driver);
      rt.register({
        name: asClassName('Cart'),
        version: asVersion('1.0.0'),
        ctor: CartV1,
        snapshotDebounceMs: 2,
      });
      await rt.tell(asClassName('Cart'), id, 'add', { n: 7 });
      await rt.drain();
      await rt.shutdown();
    }

    // Phase 2: floating
    {
      const rt = new Runtime(driver);
      rt.register({
        name: asClassName('Cart'),
        version: asVersion('2.0.0'),
        ctor: CartV2,
        snapshotDebounceMs: 2,
        floating: true,
      });
      const got = await rt.call<{ items: number; currency: string }>(
        asClassName('Cart'),
        id,
        'read',
        {},
      );
      expect(got.items).toBe(7);
      expect(got.currency).toBe('USD');

      const snap = await driver.loadSnapshot(id);
      expect(snap!.version).toBe('2.0.0');

      await rt.shutdown();
    }

    await driver.close();
  });

  it('refuses to run when persisted version is newer than registered', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const id = mkActorId();

    // Pretend a deploy of v2 ran, then we rolled back to v1.
    await driver.registerActor(id, asClassName('Cart'), asVersion('2.0.0'));
    await driver.saveSnapshot(id, {
      class: asClassName('Cart'),
      version: asVersion('2.0.0'),
      seq: 0n,
      state: { items: 99, currency: 'USD' },
    });

    const rt = new Runtime(driver);
    rt.register({
      name: asClassName('Cart'),
      version: asVersion('1.0.0'),
      ctor: CartV1,
      snapshotDebounceMs: 2,
    });

    await expect(rt.call(asClassName('Cart'), id, 'read', {})).rejects.toBeInstanceOf(
      ManifestRegression,
    );

    await rt.shutdown();
    await driver.close();
  });
});
