/**
 * In-memory implementation of {@link StorageDriver}.
 *
 * Used by unit tests and (Phase 8) the test harness. Storage is held
 * in plain JS Maps; every read/write is synchronous internally but the
 * methods return promises so the call shape matches valkey-pg exactly
 * (the conformance suite asserts identical observable behavior).
 *
 * Not safe for cross-process use — there's no IPC.
 */
import type { ActorId, ClassName, Version } from '../types/ids.js';

import {
  type AppendResult,
  type AuditEntry,
  type ClassVersionRecord,
  type EventRecord,
  type EventWrite,
  type IdempotencyRecord,
  type InboxEntry,
  type InboxRecord,
  type PublishClassInput,
  type ReminderMsg,
  type ResolvedManifest,
  type SnapshotRead,
  type SnapshotWrite,
  StaleFenceTokenError,
  type StorageDriver,
  VersionAlreadyPublishedError,
} from './driver.js';

interface ActorRow {
  class: ClassName;
  version: Version;
  createdAt: number;
  lastActiveAt?: number;
  tombstonedAt?: number;
  tags: Record<string, string>;
  /** Phase-9 fence token. Always `0n` in v1; v2 cluster bumps on placement claim. */
  fence: bigint;
}

interface SnapshotRow {
  ts: number;
  classVersion: Version;
  state: unknown;
}

interface EventRow {
  ts: number;
  classVersion: Version;
  type: string;
  payload: unknown;
  causationId?: string;
}

interface ReminderRow {
  when: number;
  msg: ReminderMsg;
  seq: number; // tiebreaker for same-when ordering
}

interface IdemRow {
  response: unknown;
  storedAt: number;
  expiresAt: number;
}

export class MemoryStorageDriver implements StorageDriver {
  private actors = new Map<ActorId, ActorRow>();
  private snapshotsByActor = new Map<ActorId, Map<bigint, SnapshotRow>>();
  private eventsByActor = new Map<ActorId, Map<bigint, EventRow>>();
  private headSeqByActor = new Map<ActorId, bigint>();

  private inboxByActor = new Map<ActorId, InboxRecord[]>();
  private inboxAckedByActor = new Map<ActorId, Set<string>>();
  private inboxSeq = 0;

  private reminders: ReminderRow[] = [];
  private reminderSeq = 0;

  private classVersions = new Map<string, ClassVersionRecord>();
  private classSource = new Map<string, Buffer>(); // keyed by sha256 hex

  private manifests = new Map<string, ResolvedManifest>();
  private idempotency = new Map<string, IdemRow>();
  private audit: AuditEntry[] = [];

  /** Settable clock for time-control in tests. */
  now: () => number = Date.now;

  async init(): Promise<void> {
    // nothing to do
  }

  async close(): Promise<void> {
    // nothing to do
  }

  /* ------------------------------------------------------- Actors */

  async registerActor(
    id: ActorId,
    cls: ClassName,
    version: Version,
    tags: Record<string, string> = {},
  ): Promise<void> {
    this.actors.set(id, {
      class: cls,
      version,
      createdAt: this.now(),
      tags,
      fence: 0n,
    });
  }

  async loadActorFence(id: ActorId): Promise<bigint> {
    return this.actors.get(id)?.fence ?? 0n;
  }

  async bumpActorFence(id: ActorId, expected: bigint): Promise<bigint> {
    const row = this.actors.get(id);
    const actual = row?.fence ?? 0n;
    if (actual !== expected) {
      throw new StaleFenceTokenError(id, expected, actual);
    }
    const next = expected + 1n;
    if (row) row.fence = next;
    return next;
  }

  async tombstoneActor(id: ActorId): Promise<void> {
    const row = this.actors.get(id);
    if (row) row.tombstonedAt = this.now();
  }

  /* ----------------------------------------------------- Snapshots */

  async loadSnapshot<S = unknown>(id: ActorId): Promise<SnapshotRead<S> | null> {
    const snaps = this.snapshotsByActor.get(id);
    const actor = this.actors.get(id);
    if (!snaps || !actor) return null;
    // Highest non-negative seq is the live snapshot. (Seq -1 is reserved for
    // the pre-migrate retention slot — Phase 3.3.)
    let best: bigint | null = null;
    for (const k of snaps.keys()) {
      if (k < 0n) continue;
      if (best === null || k > best) best = k;
    }
    if (best === null) return null;
    const row = snaps.get(best)!;
    return {
      class: actor.class,
      version: row.classVersion,
      seq: best,
      state: row.state as S,
    };
  }

  async saveSnapshot<S = unknown>(
    id: ActorId,
    snap: SnapshotWrite<S>,
    expectedFence?: bigint,
  ): Promise<void> {
    this.assertFence(id, expectedFence);
    let bucket = this.snapshotsByActor.get(id);
    if (!bucket) {
      bucket = new Map();
      this.snapshotsByActor.set(id, bucket);
    }
    bucket.set(snap.seq, {
      ts: this.now(),
      classVersion: snap.version,
      state: snap.state,
    });
    const actor = this.actors.get(id);
    if (actor) actor.lastActiveAt = this.now();
  }

  private assertFence(id: ActorId, expected: bigint | undefined): void {
    if (expected === undefined) return;
    const actual = this.actors.get(id)?.fence ?? 0n;
    if (actual !== expected) {
      throw new StaleFenceTokenError(id, expected, actual);
    }
  }

  /* ------------------------------------------------------ Events */

  async appendEvents(
    id: ActorId,
    events: EventWrite[],
    expectedFence?: bigint,
  ): Promise<AppendResult> {
    this.assertFence(id, expectedFence);
    const head = this.headSeqByActor.get(id) ?? 0n;
    if (events.length === 0) return { seq: head };
    const actor = this.actors.get(id);
    if (!actor) {
      throw new Error(`appendEvents: unknown actor ${id as string}`);
    }
    let bucket = this.eventsByActor.get(id);
    if (!bucket) {
      bucket = new Map();
      this.eventsByActor.set(id, bucket);
    }
    let seq = head;
    for (const e of events) {
      seq = seq + 1n;
      bucket.set(seq, {
        ts: this.now(),
        classVersion: actor.version,
        type: e.type,
        payload: e.payload,
        ...(e.causationId !== undefined ? { causationId: e.causationId } : {}),
      });
    }
    this.headSeqByActor.set(id, seq);
    return { seq };
  }

  readEvents(id: ActorId, fromSeq: bigint): AsyncIterable<EventRecord> {
    const bucket = this.eventsByActor.get(id);
    const actor = this.actors.get(id);
    const ordered: EventRecord[] = [];
    if (bucket && actor) {
      const keys = Array.from(bucket.keys())
        .filter((k) => k >= fromSeq)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const k of keys) {
        const row = bucket.get(k)!;
        ordered.push({
          actorId: id,
          seq: k,
          ts: row.ts,
          classVersion: row.classVersion,
          type: row.type,
          payload: row.payload,
          ...(row.causationId !== undefined ? { causationId: row.causationId } : {}),
        });
      }
    }
    return {
      async *[Symbol.asyncIterator]() {
        for (const e of ordered) yield e;
      },
    };
  }

  async headEventSeq(id: ActorId): Promise<bigint> {
    return this.headSeqByActor.get(id) ?? 0n;
  }

  /* --------------------------------------------------- Inbox stream */

  async appendInbox(id: ActorId, entry: InboxEntry): Promise<string> {
    const inboxId = `${this.now()}-${this.inboxSeq++}`;
    let bucket = this.inboxByActor.get(id);
    if (!bucket) {
      bucket = [];
      this.inboxByActor.set(id, bucket);
    }
    bucket.push({ id: inboxId, entry });
    return inboxId;
  }

  async readPendingInbox(id: ActorId, limit: number): Promise<readonly InboxRecord[]> {
    const bucket = this.inboxByActor.get(id);
    if (!bucket) return [];
    const acked = this.inboxAckedByActor.get(id) ?? new Set<string>();
    const out: InboxRecord[] = [];
    for (const r of bucket) {
      if (acked.has(r.id)) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  async ackInbox(id: ActorId, entryIds: readonly string[]): Promise<void> {
    let acked = this.inboxAckedByActor.get(id);
    if (!acked) {
      acked = new Set();
      this.inboxAckedByActor.set(id, acked);
    }
    for (const eid of entryIds) acked.add(eid);
    // Compact: drop fully-acked prefix to bound memory.
    const bucket = this.inboxByActor.get(id);
    if (bucket) {
      let drop = 0;
      while (drop < bucket.length && acked.has(bucket[drop]!.id)) drop++;
      if (drop > 0) {
        for (let i = 0; i < drop; i++) acked.delete(bucket[i]!.id);
        bucket.splice(0, drop);
      }
    }
  }

  async pendingInboxCount(id: ActorId): Promise<number> {
    const bucket = this.inboxByActor.get(id);
    if (!bucket) return 0;
    const acked = this.inboxAckedByActor.get(id);
    if (!acked || acked.size === 0) return bucket.length;
    let n = 0;
    for (const r of bucket) if (!acked.has(r.id)) n++;
    return n;
  }

  /* ---------------------------------------------------- Reminders */

  async enqueueReminder(when: number, msg: ReminderMsg): Promise<void> {
    this.reminders.push({ when, msg, seq: this.reminderSeq++ });
  }

  /**
   * Test-only: snapshot of currently-pending reminders (not yet popped),
   * ordered by their scheduled time. Used by `@actjs/test` to assert
   * `toHaveScheduled(...)`.
   */
  peekReminders(): readonly { when: number; msg: ReminderMsg }[] {
    return this.reminders
      .slice()
      .sort((a, b) => a.when - b.when || a.seq - b.seq)
      .map(({ when, msg }) => ({ when, msg }));
  }

  popDueReminders(now: number, limit: number): AsyncIterable<ReminderMsg> {
    this.reminders.sort((a, b) => a.when - b.when || a.seq - b.seq);
    const due: ReminderMsg[] = [];
    while (due.length < limit && this.reminders.length > 0) {
      const next = this.reminders[0]!;
      if (next.when > now) break;
      due.push(next.msg);
      this.reminders.shift();
    }
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of due) yield m;
      },
    };
  }

  /* --------------------------------------- Class versions & source */

  async publishClass(input: PublishClassInput): Promise<void> {
    const key = `${input.name as string}@${input.version as string}`;
    if (this.classVersions.has(key)) {
      throw new VersionAlreadyPublishedError(input.name, input.version);
    }
    const sha = hashBuf(input.source);
    this.classSource.set(sha, input.source);
    this.classVersions.set(key, {
      name: input.name,
      version: input.version,
      sourceSha256: sha,
      deps: input.deps,
      engines: input.engines,
      publishedAt: this.now(),
      floating: input.floating ?? false,
      eventSourced: input.eventSourced ?? false,
      ...(input.signature ? { signedBy: input.signature.signedBy } : {}),
    });
  }

  async getClassSource(name: ClassName, version: Version): Promise<Buffer | null> {
    const record = this.classVersions.get(`${name as string}@${version as string}`);
    if (!record) return null;
    return this.classSource.get(record.sourceSha256) ?? null;
  }

  async listClassVersions(name: ClassName): Promise<readonly ClassVersionRecord[]> {
    const prefix = `${name as string}@`;
    const out: ClassVersionRecord[] = [];
    for (const [k, v] of this.classVersions) {
      if (k.startsWith(prefix)) out.push(v);
    }
    return out;
  }

  async deprecateClassVersion(
    name: ClassName,
    version: Version,
    graceUntil?: number,
  ): Promise<void> {
    const key = `${name as string}@${version as string}`;
    const record = this.classVersions.get(key);
    if (!record) throw new Error(`unknown class version ${key}`);
    this.classVersions.set(key, {
      ...record,
      deprecatedAt: this.now(),
      ...(graceUntil !== undefined ? { graceUntil } : {}),
    });
  }

  /* ----------------------------------------------------- Manifests */

  async loadManifest(sha: string): Promise<ResolvedManifest | null> {
    return this.manifests.get(sha) ?? null;
  }

  async saveManifest(sha: string, resolved: ResolvedManifest): Promise<void> {
    this.manifests.set(sha, resolved);
  }

  /* --------------------------------------------------- Idempotency */

  async loadIdempotency<R = unknown>(key: string): Promise<IdempotencyRecord<R> | null> {
    const row = this.idempotency.get(key);
    if (!row) return null;
    if (row.expiresAt <= this.now()) {
      this.idempotency.delete(key);
      return null;
    }
    return { key, response: row.response as R, storedAt: row.storedAt };
  }

  async saveIdempotency<R = unknown>(key: string, response: R, ttlMs: number): Promise<void> {
    const now = this.now();
    this.idempotency.set(key, { response, storedAt: now, expiresAt: now + ttlMs });
  }

  /* --------------------------------------------------------- Audit */

  async appendAudit(entry: AuditEntry): Promise<void> {
    this.audit.push(entry);
  }

  /** Test helper: read the audit log without exposing internal state mutably. */
  auditEntries(): readonly AuditEntry[] {
    return this.audit;
  }
}

function hashBuf(buf: Buffer): string {
  // Cheap, deterministic; we don't need crypto strength for the memory driver.
  let h = 5381n;
  for (let i = 0; i < buf.length; i++) {
    h = ((h << 5n) + h + BigInt(buf[i]!)) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}
