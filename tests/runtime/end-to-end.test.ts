import { describe, expect, it } from 'vitest';

import { Actor } from '../../src/actor.js';
import { handler } from '../../src/handler.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { MemoryStorageDriver } from '../../src/storage/memory.js';
import { asClassName, asVersion, mkActorId } from '../../src/types/index.js';

interface CounterState {
  value: number;
}

class Counter extends Actor<CounterState> {
  override onInit(): void {
    this.state = { value: 0 };
  }

  @handler('increment')
  increment(args: { by: number }): number {
    this.state.value += args.by;
    return this.state.value;
  }

  @handler('read')
  read(): number {
    return this.state.value;
  }
}

describe('Runtime — Counter end-to-end', () => {
  it('10k sequential tells produce final state = 10000 after process restart', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const counterId = mkActorId();

    {
      const runtime = new Runtime(driver);
      runtime.register({
        name: asClassName('Counter'),
        version: asVersion('1.0.0'),
        ctor: Counter,
        // Cap covers the burst so we don't drop; snapshot debounce tight.
        mailboxCapacity: 20_000,
        snapshotDebounceMs: 5,
      });

      for (let i = 0; i < 10_000; i++) {
        await runtime.tell(asClassName('Counter'), counterId, 'increment', { by: 1 });
      }
      await runtime.drain();
      await runtime.shutdown();
    }

    // "Process restart": new Runtime, same driver.
    {
      const runtime = new Runtime(driver);
      runtime.register({
        name: asClassName('Counter'),
        version: asVersion('1.0.0'),
        ctor: Counter,
        snapshotDebounceMs: 5,
      });
      const v = await runtime.call<number>(asClassName('Counter'), counterId, 'read', {});
      expect(v).toBe(10_000);
      await runtime.shutdown();
    }

    await driver.close();
  }, 30_000);

  it('serial invariant: handlers do not overlap inside one actor', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const id = mkActorId();

    let activeHandlers = 0;
    let observedConcurrent = 0;

    class Concurrency extends Actor<{ n: number }> {
      override onInit(): void {
        this.state = { n: 0 };
      }
      @handler('work')
      async work(): Promise<number> {
        activeHandlers++;
        if (activeHandlers > 1) observedConcurrent = activeHandlers;
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        this.state.n++;
        activeHandlers--;
        return this.state.n;
      }
    }

    const runtime = new Runtime(driver);
    runtime.register({
      name: asClassName('Concurrency'),
      version: asVersion('1.0.0'),
      ctor: Concurrency,
      mailboxCapacity: 100,
      snapshotDebounceMs: 5,
    });

    // Fire 20 concurrent calls without awaiting each individually.
    const calls = Array.from({ length: 20 }, () =>
      runtime.call<number>(asClassName('Concurrency'), id, 'work', {}),
    );
    const results = await Promise.all(calls);
    expect(results.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(observedConcurrent).toBe(0);

    await runtime.shutdown();
    await driver.close();
  });

  it('multiple distinct actors are independent', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const runtime = new Runtime(driver);
    runtime.register({
      name: asClassName('Counter'),
      version: asVersion('1.0.0'),
      ctor: Counter,
      snapshotDebounceMs: 5,
    });

    const a = mkActorId();
    const b = mkActorId();
    await runtime.tell(asClassName('Counter'), a, 'increment', { by: 10 });
    await runtime.tell(asClassName('Counter'), b, 'increment', { by: 99 });
    await runtime.drain();

    expect(await runtime.call<number>(asClassName('Counter'), a, 'read', {})).toBe(10);
    expect(await runtime.call<number>(asClassName('Counter'), b, 'read', {})).toBe(99);

    await runtime.shutdown();
    await driver.close();
  });

  it('unregistered class throws on resolve', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const runtime = new Runtime(driver);
    await expect(runtime.tell(asClassName('Mystery'), mkActorId(), 'x', {})).rejects.toThrow(
      /unknown class/,
    );
    await runtime.shutdown();
    await driver.close();
  });

  it('concurrent first-touch on a cold actor activates only once', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const runtime = new Runtime(driver);
    let initCount = 0;
    class Once extends Actor<{ n: number }> {
      override onInit(): void {
        initCount++;
        this.state = { n: 0 };
      }
      @handler('ping')
      ping(): string {
        return 'pong';
      }
    }
    runtime.register({
      name: asClassName('Once'),
      version: asVersion('1.0.0'),
      ctor: Once,
      snapshotDebounceMs: 5,
    });

    const id = mkActorId();
    const r = await Promise.all([
      runtime.call(asClassName('Once'), id, 'ping', {}),
      runtime.call(asClassName('Once'), id, 'ping', {}),
      runtime.call(asClassName('Once'), id, 'ping', {}),
    ]);
    expect(r).toEqual(['pong', 'pong', 'pong']);
    expect(initCount).toBe(1);

    await runtime.shutdown();
    await driver.close();
  });
});
