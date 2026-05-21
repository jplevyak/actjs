/**
 * The single boundary every later phase calls through for durable
 * state. Two implementations: `valkey-pg.ts` (production) and
 * `memory.ts` (tests + Phase 8 harness). The conformance suite asserts
 * the two agree on observable behavior.
 *
 * Design rules:
 *   - PG is the source of truth; Valkey is rebuildable. The interface
 *     therefore reads from "the durable side" but writes through both.
 *   - All methods are async; even pure-in-memory implementations resolve
 *     so caller behavior never diverges between drivers.
 *   - Stream-shaped reads (events, reminders) return AsyncIterable so a
 *     long history doesn't have to fit in RAM.
 */
import type { ActorId, ClassName, Version } from '../types/ids.js';

/* -------------------------------------------------------------------------- *
 *  Snapshots
 * -------------------------------------------------------------------------- */

export interface SnapshotRead<S = unknown> {
  readonly class: ClassName;
  readonly version: Version;
  /** Highest event seq folded into this state. 0 for SWM actors. */
  readonly seq: bigint;
  readonly state: S;
}

export interface SnapshotWrite<S = unknown> {
  readonly class: ClassName;
  readonly version: Version;
  readonly seq: bigint;
  readonly state: S;
}

/* -------------------------------------------------------------------------- *
 *  Events
 * -------------------------------------------------------------------------- */

export interface EventWrite<P = unknown> {
  readonly type: string;
  readonly payload: P;
  readonly causationId?: string;
}

export interface EventRecord<P = unknown> {
  readonly actorId: ActorId;
  readonly seq: bigint;
  readonly ts: number;
  readonly classVersion: Version;
  readonly type: string;
  readonly payload: P;
  readonly causationId?: string;
}

export interface AppendResult {
  /** seq of the *last* appended event; equals prior head if events was empty. */
  readonly seq: bigint;
}

/* -------------------------------------------------------------------------- *
 *  Inbox stream (SWM durable mailbox)
 * -------------------------------------------------------------------------- */

export interface InboxEntry {
  readonly type: string;
  readonly payload: unknown;
}

export interface InboxRecord {
  /** Stream-style entry id, monotonically increasing. */
  readonly id: string;
  readonly entry: InboxEntry;
}

/* -------------------------------------------------------------------------- *
 *  Reminders
 * -------------------------------------------------------------------------- */

export interface ReminderMsg<P = unknown> {
  readonly actorId: ActorId;
  /** The class to dispatch through. Dispatcher uses `runtime.tell(class, id, type, payload)`. */
  readonly className: ClassName;
  readonly type: string;
  readonly payload: P;
}

/* -------------------------------------------------------------------------- *
 *  Class management
 * -------------------------------------------------------------------------- */

/** `{ "Item": "^1.0.0", "Pricing": "~2.3.0" }` */
export type DepsMap = Readonly<Record<string, string>>;

export interface ClassVersionRecord {
  readonly name: ClassName;
  readonly version: Version;
  readonly sourceSha256: string;
  readonly deps: DepsMap;
  readonly engines: Readonly<Record<string, string>>;
  readonly publishedAt: number;
  readonly deprecatedAt?: number;
  readonly graceUntil?: number;
  readonly signedBy?: string;
  readonly floating: boolean;
  readonly eventSourced: boolean;
}

export interface PublishClassInput {
  readonly name: ClassName;
  readonly version: Version;
  /** Raw source bytes (TS). Stored content-addressed in `class_blob`. */
  readonly source: Buffer;
  readonly deps: DepsMap;
  readonly engines: Readonly<Record<string, string>>;
  readonly floating?: boolean;
  readonly eventSourced?: boolean;
  readonly signature?: { signedBy: string; signature: Buffer };
}

/* -------------------------------------------------------------------------- *
 *  Manifests
 * -------------------------------------------------------------------------- */

export type ResolvedManifest = Readonly<Record<string, string>>;

/* -------------------------------------------------------------------------- *
 *  Audit
 * -------------------------------------------------------------------------- */

export interface AuditEntry {
  readonly id: string;
  readonly ts: number;
  readonly principal: string;
  readonly action: string;
  readonly target: string;
  readonly meta: Readonly<Record<string, unknown>>;
}

/* -------------------------------------------------------------------------- *
 *  Idempotency
 * -------------------------------------------------------------------------- */

export interface IdempotencyRecord<R = unknown> {
  readonly key: string;
  readonly response: R;
  readonly storedAt: number;
}

/* -------------------------------------------------------------------------- *
 *  Errors
 * -------------------------------------------------------------------------- */

export class StorageError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

export class VersionAlreadyPublishedError extends StorageError {
  constructor(name: ClassName, version: Version) {
    super(`${name as string}@${version as string} is already published`, 'VersionAlreadyPublished');
  }
}

/**
 * Thrown when a write arrives with an `expectedFence` that no longer
 * matches the actor's stored fence token. v1 never bumps the token,
 * so this never fires in single-node deployments — the check exists
 * so v2 clustering can land without rewriting the storage layer or
 * `ActorHost` (see Phase 9 cluster-seam audit).
 */
export class StaleFenceTokenError extends StorageError {
  readonly actorId: ActorId;
  readonly expected: bigint;
  readonly actual: bigint;
  constructor(actorId: ActorId, expected: bigint, actual: bigint) {
    super(
      `stale fence token for actor ${actorId as string}: expected ${expected}, got ${actual}`,
      'StaleFenceToken',
    );
    this.actorId = actorId;
    this.expected = expected;
    this.actual = actual;
  }
}

/* -------------------------------------------------------------------------- *
 *  Driver
 * -------------------------------------------------------------------------- */

export interface StorageDriver {
  /* ------------------- Actors & snapshots --------------------- */

  /**
   * Create the bookkeeping row for an actor. Snapshots and events are
   * separate writes — this only records existence + class binding.
   */
  registerActor(
    id: ActorId,
    cls: ClassName,
    version: Version,
    tags?: Record<string, string>,
  ): Promise<void>;

  /** Mark an actor tombstoned. Snapshots and events remain for audit. */
  tombstoneActor(id: ActorId): Promise<void>;

  /**
   * Read the actor's current fence token. Default `0n` for actors
   * that have never been activated. Used by `ActorHost.activate` to
   * stash the token; written back to subsequent `appendEvents` and
   * `saveSnapshot` calls as `expectedFence`. v1 never bumps the
   * token — see Phase 9 cluster-seam ADR.
   */
  loadActorFence(id: ActorId): Promise<bigint>;

  /**
   * Bump the fence token and return the new value. v2 cluster
   * placement calls this on a fresh ownership claim; v1 ActorHost
   * doesn't call it (single owner, token stays at 0).
   */
  bumpActorFence(id: ActorId, expected: bigint): Promise<bigint>;

  /** Read the highest-seq snapshot for an actor, or null. */
  loadSnapshot<S = unknown>(id: ActorId): Promise<SnapshotRead<S> | null>;

  /**
   * Write a snapshot (replaces same-seq row if it exists). When
   * `expectedFence` is supplied, the driver validates it against the
   * stored fence and throws {@link StaleFenceTokenError} on
   * mismatch — a no-op in v1 single-owner deployments.
   */
  saveSnapshot<S = unknown>(
    id: ActorId,
    snap: SnapshotWrite<S>,
    expectedFence?: bigint,
  ): Promise<void>;

  /* --------------------- Events (ES) -------------------------- */

  /**
   * Append a batch of events for one actor in a single transaction.
   *
   * The driver is responsible for assigning seqs starting at
   * `currentHead + 1`. Empty batches no-op and return the prior head.
   *
   * When `expectedFence` is supplied, the driver validates it against
   * the stored fence and throws {@link StaleFenceTokenError} on
   * mismatch — see {@link saveSnapshot}.
   */
  appendEvents(id: ActorId, events: EventWrite[], expectedFence?: bigint): Promise<AppendResult>;

  /** Stream events from `fromSeq` (inclusive) to head. */
  readEvents(id: ActorId, fromSeq: bigint): AsyncIterable<EventRecord>;

  /** Highest seq currently persisted for an actor (0 if none). */
  headEventSeq(id: ActorId): Promise<bigint>;

  /* ----------------------- Inbox stream ----------------------- */

  /** Append an inbox entry; returns its generated stream id. */
  appendInbox(id: ActorId, entry: InboxEntry): Promise<string>;

  /** Read up to `limit` pending (unacked) entries, oldest first. */
  readPendingInbox(id: ActorId, limit: number): Promise<readonly InboxRecord[]>;

  /** Ack one or more entry ids; acked entries are not replayed. */
  ackInbox(id: ActorId, entryIds: readonly string[]): Promise<void>;

  /** Count of pending (unacked) entries, for backpressure metrics. */
  pendingInboxCount(id: ActorId): Promise<number>;

  /* ----------------------- Reminders -------------------------- */

  /** Enqueue a delivery at `when` (epoch ms). */
  enqueueReminder(when: number, msg: ReminderMsg): Promise<void>;

  /** Pop up to `limit` reminders with `score <= now` atomically. */
  popDueReminders(now: number, limit: number): AsyncIterable<ReminderMsg>;

  /* ------------------ Class versions & source ----------------- */

  publishClass(input: PublishClassInput): Promise<void>;
  getClassSource(name: ClassName, version: Version): Promise<Buffer | null>;
  listClassVersions(name: ClassName): Promise<readonly ClassVersionRecord[]>;
  deprecateClassVersion(name: ClassName, version: Version, graceUntil?: number): Promise<void>;

  /* -------------------- Manifests ----------------------------- */

  loadManifest(sha: string): Promise<ResolvedManifest | null>;
  saveManifest(sha: string, resolved: ResolvedManifest): Promise<void>;

  /* -------------------- Idempotency --------------------------- */

  loadIdempotency<R = unknown>(key: string): Promise<IdempotencyRecord<R> | null>;
  saveIdempotency<R = unknown>(key: string, response: R, ttlMs: number): Promise<void>;

  /* ------------------------ Audit ----------------------------- */

  appendAudit(entry: AuditEntry): Promise<void>;

  /* ------------------------ Lifecycle ------------------------- */

  /** Connect, run migrations if needed. */
  init(): Promise<void>;

  /** Release connections. */
  close(): Promise<void>;
}
