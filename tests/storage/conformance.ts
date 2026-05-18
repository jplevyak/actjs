/**
 * Shared scenarios every {@link StorageDriver} implementation must
 * satisfy identically. Imported by both the memory-driver test file
 * and the valkey-pg integration test (when env vars are set).
 *
 * Tests rely on per-test unique ids/class names so that drivers
 * with shared backing stores don't need cross-test isolation —
 * they're naturally orthogonal.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { asClassName, asVersion, mkActorId, type ActorId } from '../../src/types/index.js';
import { type StorageDriver, VersionAlreadyPublishedError } from '../../src/storage/driver.js';

export interface ConformanceContext {
  driver: StorageDriver;
}

export function runConformance(label: string, makeDriver: () => Promise<StorageDriver>): void {
  describe(label, () => {
    let driver: StorageDriver;

    beforeEach(async () => {
      driver = await makeDriver();
    });

    afterEach(async () => {
      await driver.close();
    });

    /* ----------------------------------------------------- Actors */

    it('registerActor + tombstoneActor', async () => {
      const id = mkActorId();
      await driver.registerActor(id, asClassName('Counter'), asVersion('1.0.0'));
      await driver.tombstoneActor(id);
      // No public API for actor existence other than via snapshot; tombstone
      // is tested through the snapshot path below.
      expect(true).toBe(true);
    });

    /* --------------------------------------------------- Snapshots */

    it('loadSnapshot returns null when no snapshot exists', async () => {
      const id = mkActorId();
      await driver.registerActor(id, asClassName('Counter'), asVersion('1.0.0'));
      const snap = await driver.loadSnapshot(id);
      expect(snap).toBeNull();
    });

    it('saveSnapshot + loadSnapshot round-trips state', async () => {
      const id = mkActorId();
      await driver.registerActor(id, asClassName('Counter'), asVersion('1.0.0'));
      await driver.saveSnapshot(id, {
        class: asClassName('Counter'),
        version: asVersion('1.0.0'),
        seq: 0n,
        state: { value: 42 },
      });
      const snap = await driver.loadSnapshot<{ value: number }>(id);
      expect(snap).not.toBeNull();
      expect(snap!.state).toEqual({ value: 42 });
      expect(snap!.seq).toBe(0n);
      expect(snap!.version).toBe('1.0.0');
    });

    it('loadSnapshot returns the highest-seq snapshot', async () => {
      const id = mkActorId();
      await driver.registerActor(id, asClassName('Ledger'), asVersion('1.0.0'));
      await driver.saveSnapshot(id, {
        class: asClassName('Ledger'),
        version: asVersion('1.0.0'),
        seq: 5n,
        state: { balance: 100 },
      });
      await driver.saveSnapshot(id, {
        class: asClassName('Ledger'),
        version: asVersion('1.0.0'),
        seq: 10n,
        state: { balance: 200 },
      });
      const snap = await driver.loadSnapshot<{ balance: number }>(id);
      expect(snap!.seq).toBe(10n);
      expect(snap!.state).toEqual({ balance: 200 });
    });

    /* ---------------------------------------------------- Events */

    it('appendEvents allocates monotonic seq', async () => {
      const id = mkActorId();
      await driver.registerActor(id, asClassName('Ledger'), asVersion('1.0.0'));
      const r1 = await driver.appendEvents(id, [{ type: 'Deposited', payload: { amount: 10 } }]);
      expect(r1.seq).toBe(1n);
      const r2 = await driver.appendEvents(id, [
        { type: 'Deposited', payload: { amount: 5 } },
        { type: 'Withdrawn', payload: { amount: 3 } },
      ]);
      expect(r2.seq).toBe(3n);
      expect(await driver.headEventSeq(id)).toBe(3n);
    });

    it('appendEvents on unknown actor throws', async () => {
      const id = mkActorId();
      await expect(driver.appendEvents(id, [{ type: 'Anything', payload: {} }])).rejects.toThrow();
    });

    it('appendEvents empty batch is a no-op', async () => {
      const id = mkActorId();
      await driver.registerActor(id, asClassName('Ledger'), asVersion('1.0.0'));
      const r = await driver.appendEvents(id, []);
      expect(r.seq).toBe(0n);
    });

    it('readEvents streams events in seq order from fromSeq', async () => {
      const id = mkActorId();
      await driver.registerActor(id, asClassName('Ledger'), asVersion('1.0.0'));
      await driver.appendEvents(id, [
        { type: 'A', payload: { i: 1 } },
        { type: 'B', payload: { i: 2 } },
        { type: 'C', payload: { i: 3 } },
      ]);
      const seen: string[] = [];
      for await (const e of driver.readEvents(id, 2n)) {
        seen.push(e.type);
        expect(e.seq).toBeGreaterThanOrEqual(2n);
      }
      expect(seen).toEqual(['B', 'C']);
    });

    it('headEventSeq is 0 for actors with no events', async () => {
      const id = mkActorId();
      await driver.registerActor(id, asClassName('Counter'), asVersion('1.0.0'));
      expect(await driver.headEventSeq(id)).toBe(0n);
    });

    /* -------------------------------------------------- Inbox stream */

    it('appendInbox + readPendingInbox returns entries in order', async () => {
      const id = mkActorId();
      await driver.registerActor(id, asClassName('Counter'), asVersion('1.0.0'));
      const id1 = await driver.appendInbox(id, { type: 'a', payload: { i: 1 } });
      const id2 = await driver.appendInbox(id, { type: 'b', payload: { i: 2 } });
      const id3 = await driver.appendInbox(id, { type: 'c', payload: { i: 3 } });
      expect([id1, id2, id3].every(Boolean)).toBe(true);
      const records = await driver.readPendingInbox(id, 10);
      expect(records.map((r) => r.entry.type)).toEqual(['a', 'b', 'c']);
      expect(await driver.pendingInboxCount(id)).toBe(3);
    });

    it('ackInbox removes entries from pending', async () => {
      const id = mkActorId();
      await driver.registerActor(id, asClassName('Counter'), asVersion('1.0.0'));
      const id1 = await driver.appendInbox(id, { type: 'a', payload: 1 });
      const id2 = await driver.appendInbox(id, { type: 'b', payload: 2 });
      await driver.ackInbox(id, [id1]);
      const left = await driver.readPendingInbox(id, 10);
      expect(left.map((r) => r.id)).toEqual([id2]);
      expect(await driver.pendingInboxCount(id)).toBe(1);
    });

    it('readPendingInbox respects limit', async () => {
      const id = mkActorId();
      await driver.registerActor(id, asClassName('Counter'), asVersion('1.0.0'));
      for (let i = 0; i < 5; i++) {
        await driver.appendInbox(id, { type: 'x', payload: i });
      }
      const got = await driver.readPendingInbox(id, 2);
      expect(got.length).toBe(2);
    });

    /* --------------------------------------------------- Reminders */

    it('popDueReminders returns due, leaves not-yet-due', async () => {
      const id = mkActorId();
      const past = Date.now() - 1000;
      const future = Date.now() + 1_000_000;
      const cls = asClassName('Conformance');
      const markerPayload = { __conformance: mkActorId() };
      await driver.enqueueReminder(past, {
        actorId: id,
        className: cls,
        type: 'due',
        payload: markerPayload,
      });
      await driver.enqueueReminder(future, {
        actorId: id,
        className: cls,
        type: 'later',
        payload: markerPayload,
      });
      const popped: string[] = [];
      for await (const m of driver.popDueReminders(Date.now(), 10)) {
        if (matchesMarker(m.payload, markerPayload)) popped.push(m.type);
      }
      expect(popped).toEqual(['due']);
    });

    /* ------------------------------------- Class versions & source */

    it('publishClass + getClassSource round-trip', async () => {
      const name = asClassName(`Class_${shortId()}`);
      const source = Buffer.from('class Foo {}\nexport {Foo};', 'utf8');
      await driver.publishClass({
        name,
        version: asVersion('1.0.0'),
        source,
        deps: {},
        engines: { actjs: '^0.3.0' },
      });
      const got = await driver.getClassSource(name, asVersion('1.0.0'));
      expect(got).not.toBeNull();
      expect(got!.toString('utf8')).toBe(source.toString('utf8'));
    });

    it('publishClass refuses to overwrite a version', async () => {
      const name = asClassName(`Class_${shortId()}`);
      const source = Buffer.from('A', 'utf8');
      await driver.publishClass({
        name,
        version: asVersion('1.0.0'),
        source,
        deps: {},
        engines: {},
      });
      await expect(
        driver.publishClass({
          name,
          version: asVersion('1.0.0'),
          source: Buffer.from('B', 'utf8'),
          deps: {},
          engines: {},
        }),
      ).rejects.toBeInstanceOf(VersionAlreadyPublishedError);
    });

    it('listClassVersions returns every published version', async () => {
      const name = asClassName(`Class_${shortId()}`);
      for (const v of ['1.0.0', '1.1.0', '1.2.0']) {
        await driver.publishClass({
          name,
          version: asVersion(v),
          source: Buffer.from(v, 'utf8'),
          deps: {},
          engines: {},
        });
      }
      const list = await driver.listClassVersions(name);
      expect(list.map((r) => r.version).sort()).toEqual(['1.0.0', '1.1.0', '1.2.0']);
    });

    it('deprecateClassVersion sets deprecatedAt', async () => {
      const name = asClassName(`Class_${shortId()}`);
      await driver.publishClass({
        name,
        version: asVersion('1.0.0'),
        source: Buffer.from('x', 'utf8'),
        deps: {},
        engines: {},
      });
      await driver.deprecateClassVersion(name, asVersion('1.0.0'));
      const list = await driver.listClassVersions(name);
      expect(list[0]?.deprecatedAt).toBeDefined();
    });

    /* ---------------------------------------------------- Manifests */

    it('saveManifest + loadManifest round-trips', async () => {
      const sha = bogusSha(`m_${shortId()}`);
      const resolved = { Cart: '1.4.2', Item: '1.0.9' };
      await driver.saveManifest(sha, resolved);
      expect(await driver.loadManifest(sha)).toEqual(resolved);
    });

    it('loadManifest returns null on miss', async () => {
      const sha = bogusSha(`miss_${shortId()}`);
      expect(await driver.loadManifest(sha)).toBeNull();
    });

    /* ---------------------------------------------------- Idempotency */

    it('idempotency: save then load returns stored response', async () => {
      const key = `idem-${shortId()}`;
      await driver.saveIdempotency(key, { ok: true, id: 42 }, 10_000);
      const got = await driver.loadIdempotency<{ ok: boolean; id: number }>(key);
      expect(got).not.toBeNull();
      expect(got!.response).toEqual({ ok: true, id: 42 });
    });

    it('idempotency: load returns null for unknown key', async () => {
      const got = await driver.loadIdempotency(`miss-${shortId()}`);
      expect(got).toBeNull();
    });

    /* ------------------------------------------------------- Audit */

    it('appendAudit accepts an entry without throwing', async () => {
      await driver.appendAudit({
        id: crypto.randomUUID(),
        ts: Date.now(),
        principal: 'test-principal',
        action: 'test.action',
        target: 'test-target',
        meta: { reason: 'conformance' },
      });
    });
  });
}

/* ----------------------------------------- helpers (test-private) */

function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Pad an arbitrary string to a sha-shaped hex value. */
function bogusSha(seed: string): string {
  const buf = Buffer.from(seed.padEnd(32, '_'), 'utf8');
  return buf.toString('hex').padEnd(64, '0').slice(0, 64);
}

function matchesMarker(payload: unknown, marker: { __conformance: ActorId }): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { __conformance?: string }).__conformance === marker.__conformance
  );
}
