import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Actor } from '../../src/actor.js';
import { handler } from '../../src/handler.js';
import { MemoryStorageDriver } from '../../src/storage/memory.js';
import { ActorHost } from '../../src/runtime/host.js';
import { MailboxFullError } from '../../src/runtime/mailbox.js';
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

describe('ActorHost — single actor', () => {
  let driver: MemoryStorageDriver;
  let host: ActorHost;

  beforeEach(async () => {
    driver = new MemoryStorageDriver();
    await driver.init();
    host = new ActorHost({
      registration: {
        name: asClassName('Counter'),
        version: asVersion('1.0.0'),
        ctor: Counter,
        idleDeactivateMs: 60_000,
        snapshotDebounceMs: 10,
      },
      driver,
      id: mkActorId(),
    });
  });

  afterEach(async () => {
    await host.destroy();
    await driver.close();
  });

  it('cold-start runs onInit', async () => {
    await host.activate();
    const v = await host.call<number>('read', {});
    expect(v).toBe(0);
  });

  it('tell increments state', async () => {
    await host.tell('increment', { by: 5 });
    await host.drain();
    const v = await host.call<number>('read', {});
    expect(v).toBe(5);
  });

  it('multiple sequential tells accumulate', async () => {
    for (let i = 0; i < 100; i++) {
      await host.tell('increment', { by: 1 });
    }
    await host.drain();
    expect(await host.call<number>('read', {})).toBe(100);
  });

  it('call returns the handler return value', async () => {
    const r = await host.call<number>('increment', { by: 3 });
    expect(r).toBe(3);
    expect(await host.call<number>('read', {})).toBe(3);
  });

  it('no-handler tell logs an error and acks (no infinite replay)', async () => {
    await host.tell('does-not-exist', {});
    await host.drain();
    expect(host.metrics.handlerErrors).toBe(1n);
  });

  it('handler error in a call rejects the call', async () => {
    class Broken extends Actor<{ n: number }> {
      override onInit(): void {
        this.state = { n: 0 };
      }
      @handler('boom')
      boom(): never {
        throw new Error('boom!');
      }
    }
    const h = new ActorHost({
      registration: {
        name: asClassName('Broken'),
        version: asVersion('1.0.0'),
        ctor: Broken,
        snapshotDebounceMs: 10,
      },
      driver,
      id: mkActorId(),
    });
    await expect(h.call('boom', {})).rejects.toThrow(/boom!/);
    await h.destroy();
  });
});

describe('ActorHost — durability + restart', () => {
  it('snapshot is persisted; new host on same driver picks it up', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const id = mkActorId();

    {
      const host = new ActorHost({
        registration: {
          name: asClassName('Counter'),
          version: asVersion('1.0.0'),
          ctor: Counter,
          snapshotDebounceMs: 5,
        },
        driver,
        id,
      });
      for (let i = 0; i < 50; i++) await host.tell('increment', { by: 1 });
      await host.drain();
      // Force the trailing-debounce snapshot to flush.
      await host.destroy();
    }

    {
      const host2 = new ActorHost({
        registration: {
          name: asClassName('Counter'),
          version: asVersion('1.0.0'),
          ctor: Counter,
          snapshotDebounceMs: 5,
        },
        driver,
        id,
      });
      await host2.activate();
      const v = await host2.call<number>('read', {});
      expect(v).toBe(50);
      await host2.destroy();
    }

    await driver.close();
  });

  it('crash mid-batch replays unacked inbox on next activate', async () => {
    // Simulate "crash": create driver + host, write tells to the inbox
    // BUT prevent the worker from acking them. We do that by failing the
    // handler on the first instance; the inbox entries stay unacked. Then
    // a fresh host replays from the inbox and processes them.

    const driver = new MemoryStorageDriver();
    await driver.init();
    const id = mkActorId();

    // First host: throws on every increment, leaving inbox unacked.
    class FailingCounter extends Actor<CounterState> {
      override onInit(): void {
        this.state = { value: 0 };
      }
      @handler('increment')
      increment(): never {
        throw new Error('simulated crash');
      }
    }

    {
      const host = new ActorHost({
        registration: {
          name: asClassName('Counter'),
          version: asVersion('1.0.0'),
          ctor: FailingCounter,
          snapshotDebounceMs: 5,
        },
        driver,
        id,
      });
      for (let i = 0; i < 7; i++) await host.tell('increment', { by: 1 });
      await host.drain();
      // No snapshot written because handlers threw — state stays at 0.
      // Inbox still has 7 unacked entries.
      expect(await driver.pendingInboxCount(id)).toBe(7);
      await host.destroy();
    }

    // Second host: working handler. Inbox should replay on activate.
    {
      const host2 = new ActorHost({
        registration: {
          name: asClassName('Counter'),
          version: asVersion('1.0.0'),
          ctor: Counter,
          snapshotDebounceMs: 5,
        },
        driver,
        id,
      });
      await host2.activate();
      await host2.drain();
      const v = await host2.call<number>('read', {});
      expect(v).toBe(7);
      expect(await driver.pendingInboxCount(id)).toBe(0);
      await host2.destroy();
    }

    await driver.close();
  });
});

describe('ActorHost — backpressure', () => {
  it('call over capacity throws MailboxFullError', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();

    // Polling-gate pattern: every handler instance runs the same loop, so
    // flipping the flag releases all of them — no shared-reject ambiguity.
    let releaseAll = false;
    class Slow extends Actor<{ n: number }> {
      override onInit(): void {
        this.state = { n: 0 };
      }
      @handler('block')
      async block(): Promise<void> {
        while (!releaseAll) {
          await new Promise((r) => setTimeout(r, 2));
        }
      }
    }

    const host = new ActorHost({
      registration: {
        name: asClassName('Slow'),
        version: asVersion('1.0.0'),
        ctor: Slow,
        mailboxCapacity: 2,
        snapshotDebounceMs: 10,
      },
      driver,
      id: mkActorId(),
    });

    // First call occupies the worker.
    const c1 = host.call('block', {});
    // Two ticks lets the worker dequeue + enter the handler.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // Two more queued, filling the cap-2 mailbox.
    const c2 = host.call('block', {});
    const c3 = host.call('block', {});
    // The fourth must reject synchronously with MailboxFullError.
    await expect(host.call('block', {})).rejects.toThrow(MailboxFullError);

    releaseAll = true;
    await Promise.allSettled([c1, c2, c3]);
    await host.destroy();
    await driver.close();
  });

  it('tell over capacity drops + increments counter', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();

    let releaseAll = false;
    class Slow extends Actor<{ n: number }> {
      override onInit(): void {
        this.state = { n: 0 };
      }
      @handler('wait')
      async wait(): Promise<void> {
        while (!releaseAll) await new Promise((r) => setTimeout(r, 2));
        this.state.n++;
      }
    }

    const host = new ActorHost({
      registration: {
        name: asClassName('Slow'),
        version: asVersion('1.0.0'),
        ctor: Slow,
        mailboxCapacity: 2,
        snapshotDebounceMs: 10,
      },
      driver,
      id: mkActorId(),
    });

    // Fire 10 tells; mailbox cap 2; one in flight in the worker.
    // Expect at most 3 to be accepted (1 in worker + 2 queued), 7 dropped.
    for (let i = 0; i < 10; i++) await host.tell('wait', {});
    expect(host.metrics.tellsDropped).toBeGreaterThanOrEqual(7n);

    releaseAll = true;
    await host.drain();
    await host.destroy();
    await driver.close();
  });
});

describe('ActorHost — idle deactivation', () => {
  it('after the idle timer fires the host self-deactivates', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    let evicted = false;
    const host = new ActorHost({
      registration: {
        name: asClassName('Counter'),
        version: asVersion('1.0.0'),
        ctor: Counter,
        snapshotDebounceMs: 5,
        idleDeactivateMs: 50,
      },
      driver,
      id: mkActorId(),
      onIdleEvict: () => {
        evicted = true;
      },
    });
    await host.tell('increment', { by: 1 });
    await host.drain();
    // Wait past the idle window.
    await new Promise((r) => setTimeout(r, 120));
    expect(evicted).toBe(true);
    await host.destroy();
    await driver.close();
  });
});
