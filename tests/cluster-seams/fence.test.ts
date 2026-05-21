/**
 * Phase-9 cluster-seam: fence token plumbing.
 *
 * v1 single-owner deployments never bump the fence; these tests
 * cover the driver-side check that v2 will rely on to refuse stale
 * writes. The runtime + host call sites pass the stashed token on
 * every write, so a desync between the host's stashed token and
 * the driver's stored fence throws `StaleFenceTokenError`.
 */
import { describe, expect, it } from 'vitest';

import { StaleFenceTokenError } from '../../src/storage/driver.js';
import { MemoryStorageDriver } from '../../src/storage/memory.js';
import { asClassName, asVersion, mkActorId } from '../../src/types/index.js';

describe('actor fence token', () => {
  it('loadActorFence defaults to 0 for never-registered actors', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const id = mkActorId();
    expect(await driver.loadActorFence(id)).toBe(0n);
  });

  it('loadActorFence returns 0 after registerActor', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const id = mkActorId();
    await driver.registerActor(id, asClassName('Counter'), asVersion('1.0.0'));
    expect(await driver.loadActorFence(id)).toBe(0n);
  });

  it('bumpActorFence increments only when expected matches', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const id = mkActorId();
    await driver.registerActor(id, asClassName('Counter'), asVersion('1.0.0'));
    expect(await driver.bumpActorFence(id, 0n)).toBe(1n);
    expect(await driver.loadActorFence(id)).toBe(1n);
    await expect(driver.bumpActorFence(id, 0n)).rejects.toBeInstanceOf(StaleFenceTokenError);
  });

  it('saveSnapshot without expectedFence skips the check (back-compat path)', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const id = mkActorId();
    await driver.registerActor(id, asClassName('Counter'), asVersion('1.0.0'));
    // Bump twice so stored fence is 2.
    await driver.bumpActorFence(id, 0n);
    await driver.bumpActorFence(id, 1n);
    // Snapshot write without fence is allowed (preserves driver
    // back-compat for callers that pre-date Phase 9).
    await driver.saveSnapshot(id, {
      class: asClassName('Counter'),
      version: asVersion('1.0.0'),
      seq: 0n,
      state: { n: 1 },
    });
  });

  it('saveSnapshot with matching expectedFence succeeds', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const id = mkActorId();
    await driver.registerActor(id, asClassName('Counter'), asVersion('1.0.0'));
    await driver.saveSnapshot(
      id,
      {
        class: asClassName('Counter'),
        version: asVersion('1.0.0'),
        seq: 0n,
        state: { n: 1 },
      },
      0n,
    );
  });

  it('saveSnapshot with mismatched expectedFence throws StaleFenceTokenError', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const id = mkActorId();
    await driver.registerActor(id, asClassName('Counter'), asVersion('1.0.0'));
    await driver.bumpActorFence(id, 0n); // stored = 1
    await expect(
      driver.saveSnapshot(
        id,
        {
          class: asClassName('Counter'),
          version: asVersion('1.0.0'),
          seq: 0n,
          state: { n: 1 },
        },
        0n, // expected stale
      ),
    ).rejects.toBeInstanceOf(StaleFenceTokenError);
  });

  it('appendEvents with mismatched expectedFence throws', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const id = mkActorId();
    await driver.registerActor(id, asClassName('Counter'), asVersion('1.0.0'));
    await driver.bumpActorFence(id, 0n);
    await expect(
      driver.appendEvents(id, [{ type: 'Tick', payload: {} }], 0n),
    ).rejects.toBeInstanceOf(StaleFenceTokenError);
  });

  it('host activate reads fence 0 and writes carry it', async () => {
    // End-to-end smoke through the TestRuntime: every flushed
    // snapshot during a v1 session uses fence 0, the driver's
    // stored fence stays at 0, and the check passes.
    const { TestRuntime } = await import('../../src/test/index.js');
    const { Actor } = await import('../../src/actor.js');
    const { handler } = await import('../../src/handler.js');
    class Counter extends Actor<{ n: number }> {
      override onInit(): void {
        this.state = { n: 0 };
      }
      @handler('inc')
      inc(): number {
        this.state.n++;
        return this.state.n;
      }
    }
    const t = await TestRuntime.create({ classes: { Counter } });
    const a = t.actor(Counter);
    await a.call.inc({});
    await a.call.inc({});
    await t.drain();
    expect(await t.driver.loadActorFence(a.id)).toBe(0n);
    await t.close();
  });
});
