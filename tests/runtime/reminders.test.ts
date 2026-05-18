import { describe, expect, it } from 'vitest';

import { Actor } from '../../src/actor.js';
import { handler } from '../../src/handler.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { MemoryStorageDriver } from '../../src/storage/memory.js';
import { asClassName, asVersion, mkActorId } from '../../src/types/index.js';

interface NotifyState {
  pings: number;
  reasons: string[];
}

class Pinger extends Actor<NotifyState> {
  override onInit(): void {
    this.state = { pings: 0, reasons: [] };
  }

  @handler('ping')
  ping(args: { reason: string }): void {
    this.state.pings++;
    this.state.reasons.push(args.reason);
  }

  @handler('read')
  read(): NotifyState {
    return this.state;
  }
}

describe('Reminders — basic dispatch', () => {
  it('fires a scheduled tell within the dispatcher tick window', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const runtime = new Runtime(driver, { reminders: { tickMs: 10 } });
    runtime.register({
      name: asClassName('Pinger'),
      version: asVersion('1.0.0'),
      ctor: Pinger,
      snapshotDebounceMs: 5,
    });
    const id = mkActorId();

    await runtime.scheduleReminder(asClassName('Pinger'), id, Date.now() + 20, 'ping', {
      reason: 'reminder-fired',
    });

    // Wait long enough for the tick + the dispatch + the handler.
    await new Promise((r) => setTimeout(r, 120));

    const got = await runtime.call<NotifyState>(asClassName('Pinger'), id, 'read', {});
    expect(got.pings).toBe(1);
    expect(got.reasons).toEqual(['reminder-fired']);

    await runtime.shutdown();
    await driver.close();
  });

  it('respects scheduled time: not-yet-due reminders do not fire early', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const runtime = new Runtime(driver, { reminders: { tickMs: 10 } });
    runtime.register({
      name: asClassName('Pinger'),
      version: asVersion('1.0.0'),
      ctor: Pinger,
      snapshotDebounceMs: 5,
    });
    const id = mkActorId();

    await runtime.scheduleReminder(asClassName('Pinger'), id, Date.now() + 60_000, 'ping', {
      reason: 'should-not-fire',
    });

    await new Promise((r) => setTimeout(r, 60));

    const got = await runtime.call<NotifyState>(asClassName('Pinger'), id, 'read', {});
    expect(got.pings).toBe(0);

    await runtime.shutdown();
    await driver.close();
  });
});

describe('Reminders — survive runtime restart', () => {
  it('a reminder scheduled in runtime A fires after restart in runtime B', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const id = mkActorId();

    // Runtime A: enqueue + shut down before the reminder fires.
    {
      const rtA = new Runtime(driver, { reminders: { tickMs: 10 } });
      rtA.register({
        name: asClassName('Pinger'),
        version: asVersion('1.0.0'),
        ctor: Pinger,
        snapshotDebounceMs: 5,
      });
      await rtA.scheduleReminder(asClassName('Pinger'), id, Date.now() + 40, 'ping', {
        reason: 'survived-restart',
      });
      await rtA.shutdown();
    }

    // Wait past the scheduled time, then bring up Runtime B against
    // the same driver and let its dispatcher tick.
    await new Promise((r) => setTimeout(r, 80));
    const rtB = new Runtime(driver, { reminders: { tickMs: 10 } });
    rtB.register({
      name: asClassName('Pinger'),
      version: asVersion('1.0.0'),
      ctor: Pinger,
      snapshotDebounceMs: 5,
    });
    // Tickle the dispatcher by scheduling a no-op so it starts.
    // (In production it'd be started by the first scheduleReminder
    // of this process, or explicitly via runtime.reminderDispatcher.start().)
    rtB.reminderDispatcher.start();
    await new Promise((r) => setTimeout(r, 80));

    const got = await rtB.call<NotifyState>(asClassName('Pinger'), id, 'read', {});
    expect(got.pings).toBe(1);
    expect(got.reasons).toEqual(['survived-restart']);

    await rtB.shutdown();
    await driver.close();
  }, 10_000);
});

describe('Reminders — dispatcher metrics', () => {
  it('tracks delivery counts', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const runtime = new Runtime(driver, { reminders: { tickMs: 5 } });
    runtime.register({
      name: asClassName('Pinger'),
      version: asVersion('1.0.0'),
      ctor: Pinger,
      snapshotDebounceMs: 2,
    });
    const id = mkActorId();

    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      await runtime.scheduleReminder(asClassName('Pinger'), id, t0 + 10, 'ping', {
        reason: `r${i}`,
      });
    }

    // Wait for delivery.
    await new Promise((r) => setTimeout(r, 100));

    const got = await runtime.call<NotifyState>(asClassName('Pinger'), id, 'read', {});
    expect(got.pings).toBe(5);
    expect(runtime.reminderDispatcher.delivered).toBe(5n);

    await runtime.shutdown();
    await driver.close();
  });
});
