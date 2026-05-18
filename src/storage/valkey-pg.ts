/**
 * Production storage driver: Postgres as the source of truth, Valkey
 * as the hot cache + liveness queue.
 *
 * Per-method behavior is documented in {@link StorageDriver}; here we
 * just translate. The transactional invariants are noted next to the
 * SQL.
 */
import { createHash, randomUUID } from 'node:crypto';

import pg from 'pg';
import { createClient, type RedisClientType } from 'redis';

import type { ActorId, ClassName, Version } from '../types/ids.js';

import { decodeSnapshot, encodeSnapshot, isOversizedSnapshot } from './codec.js';
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
  type StorageDriver,
  VersionAlreadyPublishedError,
} from './driver.js';
import { k } from './keys.js';
import { applyMigrations } from './migrate.js';

const { Pool } = pg;

export interface ValkeyPgOptions {
  postgresUrl: string;
  redisUrl?: string;
  /** Run pending migrations during {@link init}. Default `true`. */
  applyMigrations?: boolean;
  /** Hot-snapshot TTL in seconds. 0 = no TTL (default; rely on idle eviction). */
  hotTtlSeconds?: number;
  /** Pool size. Falls back to pg.Pool default. */
  maxConnections?: number;
}

export class ValkeyPgStorageDriver implements StorageDriver {
  private pool!: pg.Pool;
  private redis!: RedisClientType;
  private readonly options: Required<Pick<ValkeyPgOptions, 'applyMigrations' | 'hotTtlSeconds'>> &
    ValkeyPgOptions;
  /** Counts snapshot writes that exceed the warn threshold (Phase 8 metric). */
  oversizedSnapshotCount = 0;

  constructor(options: ValkeyPgOptions) {
    this.options = {
      applyMigrations: true,
      hotTtlSeconds: 0,
      ...options,
    };
  }

  /* ----------------------------------------------------- Lifecycle */

  async init(): Promise<void> {
    this.pool = new Pool({
      connectionString: this.options.postgresUrl,
      ...(this.options.maxConnections !== undefined ? { max: this.options.maxConnections } : {}),
    });
    this.redis = (
      this.options.redisUrl ? createClient({ url: this.options.redisUrl }) : createClient()
    ) as RedisClientType;
    this.redis.on('error', (err: unknown) => {
      console.error('valkey-pg: redis error:', err);
    });
    await this.redis.connect();
    if (this.options.applyMigrations) {
      await applyMigrations(this.pool);
    }
    // Re-prime the Valkey ZSET from any reminders that the previous
    // process didn't deliver. ZADD is idempotent so this is safe even
    // when Valkey survived but PG didn't.
    await this.recoverReminders();
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
    await this.pool.end();
  }

  /**
   * Test-only: truncate all tables and flush the Valkey namespace.
   * Production callers should never use this — call sites that need
   * to scrub data should narrow their changes.
   */
  async __resetForTests(): Promise<void> {
    await this.pool.query(
      `TRUNCATE actor, actor_snapshot, actor_event, class_version, class_blob,
                manifest, audit, _migrations RESTART IDENTITY CASCADE`,
    );
    await this.redis.flushDb();
  }

  /* -------------------------------------------------------- Actors */

  async registerActor(
    id: ActorId,
    cls: ClassName,
    version: Version,
    tags: Record<string, string> = {},
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO actor (id, class, version, tags)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (id) DO UPDATE
       SET class = EXCLUDED.class, version = EXCLUDED.version, tags = EXCLUDED.tags`,
      [id, cls, version, JSON.stringify(tags)],
    );
  }

  async tombstoneActor(id: ActorId): Promise<void> {
    await this.pool.query(`UPDATE actor SET tombstoned_at = now() WHERE id = $1`, [id]);
    await this.redis.del(k.actorHot(id)).catch(() => 0);
  }

  /* ----------------------------------------------------- Snapshots */

  async loadSnapshot<S = unknown>(id: ActorId): Promise<SnapshotRead<S> | null> {
    // Hot path: Valkey cache. Stored as base64 to avoid binary-safety
    // surprises across older redis client versions.
    const cached = await this.redis.get(k.actorHot(id));
    if (cached) {
      try {
        const bytes = Buffer.from(cached, 'base64');
        const wrapped = JSON.parse(decodeSnapshot<string>(bytes)) as CachedSnapshot;
        return {
          class: wrapped.class as ClassName,
          version: wrapped.version as Version,
          seq: BigInt(wrapped.seq),
          state: wrapped.state as S,
        };
      } catch {
        // Corrupt cache: fall through to PG.
      }
    }
    const result = await this.pool.query<{
      seq: string;
      class_version: string;
      bytes: Buffer;
      class: string;
    }>(
      `SELECT s.seq::text AS seq, s.class_version, s.bytes, a.class
       FROM actor_snapshot s
       JOIN actor a ON a.id = s.actor_id
       WHERE s.actor_id = $1 AND s.seq >= 0
       ORDER BY s.seq DESC LIMIT 1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    const state = decodeSnapshot<S>(row.bytes);
    const snap: SnapshotRead<S> = {
      class: row.class as ClassName,
      version: row.class_version as Version,
      seq: BigInt(row.seq),
      state,
    };
    await this.writeHotCache(id, snap);
    return snap;
  }

  async saveSnapshot<S = unknown>(id: ActorId, snap: SnapshotWrite<S>): Promise<void> {
    const bytes = encodeSnapshot(snap.state);
    if (isOversizedSnapshot(bytes)) this.oversizedSnapshotCount++;
    await this.pool.query(
      `INSERT INTO actor_snapshot (actor_id, seq, class_version, bytes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (actor_id, seq) DO UPDATE
       SET class_version = EXCLUDED.class_version,
           bytes = EXCLUDED.bytes,
           ts = now()`,
      [id, snap.seq.toString(), snap.version, bytes],
    );
    await this.pool.query(`UPDATE actor SET last_active_at = now() WHERE id = $1`, [id]);
    await this.writeHotCache(id, {
      class: (await this.lookupActorClass(id)) ?? snap.version,
      version: snap.version,
      seq: snap.seq,
      state: snap.state,
    } as SnapshotRead<unknown>);
  }

  private async lookupActorClass(id: ActorId): Promise<ClassName | null> {
    const r = await this.pool.query<{ class: string }>(`SELECT class FROM actor WHERE id = $1`, [
      id,
    ]);
    return (r.rows[0]?.class as ClassName) ?? null;
  }

  private async writeHotCache(id: ActorId, snap: SnapshotRead): Promise<void> {
    const wrapped: CachedSnapshot = {
      class: snap.class as string,
      version: snap.version as string,
      seq: snap.seq.toString(),
      state: snap.state,
    };
    const bytes = encodeSnapshot(JSON.stringify(wrapped));
    const b64 = bytes.toString('base64');
    if (this.options.hotTtlSeconds > 0) {
      await this.redis.set(k.actorHot(id), b64, { EX: this.options.hotTtlSeconds });
    } else {
      await this.redis.set(k.actorHot(id), b64);
    }
  }

  /* ---------------------------------------------------- Events (ES) */

  async appendEvents(id: ActorId, events: EventWrite[]): Promise<AppendResult> {
    if (events.length === 0) {
      return { seq: await this.headEventSeq(id) };
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query<{ max: string | null; version: string }>(
        `SELECT COALESCE(MAX(e.seq)::text, '0') AS max, a.version
         FROM actor a
         LEFT JOIN actor_event e ON e.actor_id = a.id
         WHERE a.id = $1
         GROUP BY a.version`,
        [id],
      );
      const r0 = row.rows[0];
      if (!r0) {
        await client.query('ROLLBACK');
        throw new Error(`appendEvents: unknown actor ${id as string}`);
      }
      let seq = BigInt(r0.max ?? '0');
      const version = r0.version;
      for (const e of events) {
        seq = seq + 1n;
        await client.query(
          `INSERT INTO actor_event (actor_id, seq, class_version, type, payload, causation_id)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [id, seq.toString(), version, e.type, JSON.stringify(e.payload), e.causationId ?? null],
        );
      }
      await client.query('COMMIT');
      return { seq };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async *readEvents(id: ActorId, fromSeq: bigint): AsyncIterable<EventRecord> {
    const result = await this.pool.query<{
      seq: string;
      ts: Date;
      class_version: string;
      type: string;
      payload: unknown;
      causation_id: string | null;
    }>(
      `SELECT seq::text AS seq, ts, class_version, type, payload, causation_id
       FROM actor_event
       WHERE actor_id = $1 AND seq >= $2
       ORDER BY seq`,
      [id, fromSeq.toString()],
    );
    for (const row of result.rows) {
      yield {
        actorId: id,
        seq: BigInt(row.seq),
        ts: row.ts.getTime(),
        classVersion: row.class_version as Version,
        type: row.type,
        payload: row.payload,
        ...(row.causation_id ? { causationId: row.causation_id } : {}),
      };
    }
  }

  async headEventSeq(id: ActorId): Promise<bigint> {
    const r = await this.pool.query<{ max: string | null }>(
      `SELECT COALESCE(MAX(seq)::text, '0') AS max FROM actor_event WHERE actor_id = $1`,
      [id],
    );
    return BigInt(r.rows[0]?.max ?? '0');
  }

  /* --------------------------------------------------- Inbox stream */
  // Plain Valkey stream with XADD-on-append, XRANGE-on-read, XDEL-on-ack.
  // No consumer groups: there is exactly one ActorHost owning the stream,
  // so the PEL dance buys nothing and the simple semantics make replay
  // straightforward.

  async appendInbox(id: ActorId, entry: InboxEntry): Promise<string> {
    return await this.redis.xAdd(k.actorInbox(id), '*', {
      type: entry.type,
      payload: JSON.stringify(entry.payload),
    });
  }

  async readPendingInbox(id: ActorId, limit: number): Promise<readonly InboxRecord[]> {
    const res = await this.redis.xRange(k.actorInbox(id), '-', '+', { COUNT: limit });
    return res.map((m) => ({
      id: m.id,
      entry: {
        type: m.message['type'] ?? 'unknown',
        payload: JSON.parse(m.message['payload'] ?? 'null'),
      },
    }));
  }

  async ackInbox(id: ActorId, entryIds: readonly string[]): Promise<void> {
    if (entryIds.length === 0) return;
    await this.redis.xDel(k.actorInbox(id), entryIds as string[]);
  }

  async pendingInboxCount(id: ActorId): Promise<number> {
    return await this.redis.xLen(k.actorInbox(id));
  }

  /* ----------------------------------------------------- Reminders */
  // PG is the durable source of truth; Valkey ZSET is the live dispatch
  // queue. Each reminder is wrapped in a {id, msg} envelope so the Lua
  // pop returns enough information to mark the PG row delivered without
  // a second lookup.

  async enqueueReminder(when: number, msg: ReminderMsg): Promise<void> {
    const reminderId = randomUUID();
    await this.pool.query(
      `INSERT INTO reminder (id, when_ms, actor_id, class, type, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [reminderId, when, msg.actorId, msg.className, msg.type, JSON.stringify(msg.payload)],
    );
    const member = JSON.stringify({ id: reminderId, msg });
    await this.redis.zAdd(k.reminders, { score: when, value: member });
  }

  async *popDueReminders(now: number, limit: number): AsyncIterable<ReminderMsg> {
    const script = `
      local members = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
      if #members > 0 then
        redis.call('ZREM', KEYS[1], unpack(members))
      end
      return members
    `;
    const members = (await this.redis.eval(script, {
      keys: [k.reminders],
      arguments: [String(now), String(limit)],
    })) as string[];
    if (members.length === 0) return;
    const envelopes = members.map((m) => JSON.parse(m) as { id: string; msg: ReminderMsg });
    // Mark PG rows delivered. A crash between the Valkey pop and this UPDATE
    // leaves the PG row undelivered — the next init() will re-enqueue,
    // resulting in at-most-once-with-occasional-duplicates semantics.
    await this.pool.query(
      `UPDATE reminder SET delivered_at = now()
       WHERE id = ANY($1::uuid[])`,
      [envelopes.map((e) => e.id)],
    );
    for (const e of envelopes) yield e.msg;
  }

  /**
   * Reload undelivered reminders from PG into the Valkey ZSET.
   * Idempotent: ZADD with the same member is a no-op. Used by `init()`
   * after the storage layer comes back up.
   */
  private async recoverReminders(): Promise<void> {
    const rows = await this.pool.query<{
      id: string;
      when_ms: string;
      actor_id: string;
      class: string;
      type: string;
      payload: unknown;
    }>(
      `SELECT id, when_ms::text AS when_ms, actor_id, class, type, payload
       FROM reminder
       WHERE delivered_at IS NULL`,
    );
    for (const row of rows.rows) {
      const msg: ReminderMsg = {
        actorId: row.actor_id as ActorId,
        className: row.class as ClassName,
        type: row.type,
        payload: row.payload,
      };
      const member = JSON.stringify({ id: row.id, msg });
      await this.redis.zAdd(k.reminders, {
        score: Number(row.when_ms),
        value: member,
      });
    }
  }

  /* ----------------------------------------- Class versions & source */

  async publishClass(input: PublishClassInput): Promise<void> {
    const sha = sha256Hex(input.source);
    const shaBuf = Buffer.from(sha, 'hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO class_blob (sha256, bytes) VALUES ($1, $2)
         ON CONFLICT (sha256) DO NOTHING`,
        [shaBuf, input.source],
      );
      try {
        await client.query(
          `INSERT INTO class_version
           (name, version, source_sha256, deps, engines, floating, event_sourced, signed_by, signature)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)`,
          [
            input.name,
            input.version,
            shaBuf,
            JSON.stringify(input.deps),
            JSON.stringify(input.engines),
            input.floating ?? false,
            input.eventSourced ?? false,
            input.signature?.signedBy ?? null,
            input.signature?.signature ?? null,
          ],
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          await client.query('ROLLBACK');
          throw new VersionAlreadyPublishedError(input.name, input.version);
        }
        throw err;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async getClassSource(name: ClassName, version: Version): Promise<Buffer | null> {
    const r = await this.pool.query<{ bytes: Buffer }>(
      `SELECT b.bytes
       FROM class_version v
       JOIN class_blob b ON b.sha256 = v.source_sha256
       WHERE v.name = $1 AND v.version = $2`,
      [name, version],
    );
    return r.rows[0]?.bytes ?? null;
  }

  async listClassVersions(name: ClassName): Promise<readonly ClassVersionRecord[]> {
    const r = await this.pool.query<{
      name: string;
      version: string;
      source_sha256: Buffer;
      deps: DepsMapJson;
      engines: Record<string, string>;
      published_at: Date;
      deprecated_at: Date | null;
      grace_until: Date | null;
      signed_by: string | null;
      floating: boolean;
      event_sourced: boolean;
    }>(
      `SELECT name, version, source_sha256, deps, engines, published_at,
              deprecated_at, grace_until, signed_by, floating, event_sourced
       FROM class_version
       WHERE name = $1
       ORDER BY published_at`,
      [name],
    );
    return r.rows.map((row) => ({
      name: row.name as ClassName,
      version: row.version as Version,
      sourceSha256: row.source_sha256.toString('hex'),
      deps: row.deps,
      engines: row.engines,
      publishedAt: row.published_at.getTime(),
      ...(row.deprecated_at ? { deprecatedAt: row.deprecated_at.getTime() } : {}),
      ...(row.grace_until ? { graceUntil: row.grace_until.getTime() } : {}),
      ...(row.signed_by ? { signedBy: row.signed_by } : {}),
      floating: row.floating,
      eventSourced: row.event_sourced,
    }));
  }

  async deprecateClassVersion(
    name: ClassName,
    version: Version,
    graceUntil?: number,
  ): Promise<void> {
    const grace = graceUntil ? new Date(graceUntil) : null;
    await this.pool.query(
      `UPDATE class_version
       SET deprecated_at = now(), grace_until = $3
       WHERE name = $1 AND version = $2`,
      [name, version, grace],
    );
  }

  /* ---------------------------------------------------- Manifests */

  async loadManifest(sha: string): Promise<ResolvedManifest | null> {
    const cacheKey = k.manifestCache(sha);
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as ResolvedManifest;
    const r = await this.pool.query<{ resolved: ResolvedManifest }>(
      `SELECT resolved FROM manifest WHERE sha256 = $1`,
      [Buffer.from(sha, 'hex')],
    );
    const resolved = r.rows[0]?.resolved ?? null;
    if (resolved) await this.redis.set(cacheKey, JSON.stringify(resolved));
    return resolved;
  }

  async saveManifest(sha: string, resolved: ResolvedManifest): Promise<void> {
    await this.pool.query(
      `INSERT INTO manifest (sha256, resolved) VALUES ($1, $2::jsonb)
       ON CONFLICT (sha256) DO NOTHING`,
      [Buffer.from(sha, 'hex'), JSON.stringify(resolved)],
    );
    await this.redis.set(k.manifestCache(sha), JSON.stringify(resolved));
  }

  /* --------------------------------------------------- Idempotency */

  async loadIdempotency<R = unknown>(key: string): Promise<IdempotencyRecord<R> | null> {
    const raw = await this.redis.get(k.idempotency(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { response: R; storedAt: number };
    return { key, response: parsed.response, storedAt: parsed.storedAt };
  }

  async saveIdempotency<R = unknown>(key: string, response: R, ttlMs: number): Promise<void> {
    const payload = JSON.stringify({ response, storedAt: Date.now() });
    await this.redis.set(k.idempotency(key), payload, { PX: ttlMs });
  }

  /* --------------------------------------------------------- Audit */

  async appendAudit(entry: AuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit (id, ts, principal, action, target, meta)
       VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6::jsonb)`,
      [
        entry.id || randomUUID(),
        entry.ts,
        entry.principal,
        entry.action,
        entry.target,
        JSON.stringify(entry.meta),
      ],
    );
  }
}

/* ---------------------------------------------------- Internal types */

interface CachedSnapshot {
  class: string;
  version: string;
  seq: string;
  state: unknown;
}

type DepsMapJson = Readonly<Record<string, string>>;

/* --------------------------------------------------------- Helpers */

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === '23505'
  );
}
