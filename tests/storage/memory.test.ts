/**
 * Memory-driver test suite.
 *
 * Pulls in the shared conformance suite (always runs) plus a few
 * memory-specific tests for behavior the conformance suite can't
 * easily exercise against valkey-pg (settable clock, audit read).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryStorageDriver } from '../../src/storage/memory.js';
import { asClassName, asVersion, mkActorId } from '../../src/types/index.js';

import { runConformance } from './conformance.js';

runConformance('memory driver — conformance', async () => {
  const d = new MemoryStorageDriver();
  await d.init();
  return d;
});

describe('memory driver — settable clock', () => {
  let driver: MemoryStorageDriver;
  beforeEach(async () => {
    driver = new MemoryStorageDriver();
    await driver.init();
  });
  afterEach(async () => {
    await driver.close();
  });

  it('idempotency entries expire at the stored TTL', async () => {
    let t = 1_000_000;
    driver.now = () => t;
    await driver.saveIdempotency('key-1', { hi: 'there' }, 5_000);
    expect((await driver.loadIdempotency('key-1'))?.response).toEqual({ hi: 'there' });
    t += 4_999;
    expect(await driver.loadIdempotency('key-1')).not.toBeNull();
    t += 2;
    expect(await driver.loadIdempotency('key-1')).toBeNull();
  });

  it('audit log is appended and observable via the test helper', async () => {
    await driver.appendAudit({
      id: 'audit-1',
      ts: 1234,
      principal: 'me',
      action: 'class.published',
      target: 'Cart@1.0.0',
      meta: {},
    });
    expect(driver.auditEntries().map((e) => e.action)).toEqual(['class.published']);
  });
});

describe('memory driver — pre-migrate snapshot slot ignored on load', () => {
  it('snapshot at seq -1 is hidden from loadSnapshot', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const id = mkActorId();
    await driver.registerActor(id, asClassName('Counter'), asVersion('1.0.0'));
    await driver.saveSnapshot(id, {
      class: asClassName('Counter'),
      version: asVersion('1.0.0'),
      seq: -1n,
      state: { v: 'pre-migrate' },
    });
    await driver.saveSnapshot(id, {
      class: asClassName('Counter'),
      version: asVersion('1.0.0'),
      seq: 0n,
      state: { v: 'live' },
    });
    const snap = await driver.loadSnapshot<{ v: string }>(id);
    expect(snap!.state).toEqual({ v: 'live' });
    expect(snap!.seq).toBe(0n);
    await driver.close();
  });
});
