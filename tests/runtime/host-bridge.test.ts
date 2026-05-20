import { describe, expect, it } from 'vitest';

import { Actor } from '../../src/actor.js';
import { handler } from '../../src/handler.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { MemoryStorageDriver } from '../../src/storage/memory.js';
import { asClassName, asVersion, mkActorId } from '../../src/types/index.js';

import { ActorAbort, makeBridge, SILENT_LOGGER } from '../../src/runtime/host-bridge.js';

/* -------------------------------------------------- pure bridge tests */

describe('makeBridge', () => {
  it('throws ActorAbort from abort()', () => {
    const bridge = makeBridge({
      self: { id: 'a' as never, class: 'X' as never, version: '1.0.0' as never },
    });
    expect(() => bridge.abort('nope')).toThrow(ActorAbort);
  });

  it('uses the provided now() and log', () => {
    const bridge = makeBridge({
      self: { id: 'a' as never, class: 'X' as never, version: '1.0.0' as never },
      now: () => 1234,
      log: SILENT_LOGGER,
    });
    expect(bridge.now()).toBe(1234);
  });

  it('rejects call/tell when no outbound is wired', async () => {
    const bridge = makeBridge({
      self: { id: 'a' as never, class: 'X' as never, version: '1.0.0' as never },
    });
    await expect(
      bridge.call({ id: 'b' as never, class: 'Y' as never, version: '1.0.0' as never }, 'x', {}),
    ).rejects.toThrow(/no runtime/);
  });
});

/* ----------------- end-to-end: this.actjs.call across two actors */

interface PingerState {
  pongs: number;
}

class Pinger extends Actor<PingerState> {
  override onInit(): void {
    this.state = { pongs: 0 };
  }
  @handler('callTarget')
  async callTarget(args: { targetClass: string; targetId: string }): Promise<unknown> {
    return await this.actjs!.call(
      {
        id: args.targetId as never,
        class: args.targetClass as never,
        version: '1.0.0' as never,
      },
      'pong',
      { from: this.actjs!.self.id },
    );
  }
  @handler('pong')
  pong(args: { from: string }): { from: string; pongs: number } {
    this.state.pongs++;
    return { from: args.from, pongs: this.state.pongs };
  }
}

describe('Runtime + this.actjs bridge', () => {
  it('handlers can route a call to another actor via this.actjs.call', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const rt = new Runtime(driver);
    rt.register({
      name: asClassName('Pinger'),
      version: asVersion('1.0.0'),
      ctor: Pinger,
      snapshotDebounceMs: 2,
    });

    const a = mkActorId();
    const b = mkActorId();
    const result = (await rt.call(asClassName('Pinger'), a, 'callTarget', {
      targetClass: 'Pinger',
      targetId: b as string,
    })) as { from: string; pongs: number };
    expect(result.from).toBe(a);
    expect(result.pongs).toBe(1);

    await rt.shutdown();
    await driver.close();
  });
});
