/**
 * `ActorHost`: the per-actor owner.
 *
 * Owns the deserialized actor instance, a serial mailbox, the
 * activation lifecycle, snapshot persistence, and an idle
 * deactivation timer. One ActorHost per ActorId per process.
 *
 * Two commit modes share one worker loop and one inbox stream:
 *
 *   - **SWM** (default `Actor<S>` subclasses) — handlers mutate
 *     `state` directly. Snapshots flush on a trailing 250 ms
 *     debounce.
 *
 *   - **ES** (`EventSourced<S, E>` subclasses) — handlers return
 *     `E[]`. The host appends those events through `appendEvents`,
 *     folds them into state with the user's pure `reduce`, and
 *     snapshots every `snapshotEveryNEvents` events (default 100).
 *
 * The branch is decided once per activation by `instanceof
 * EventSourced`; the rest of the host doesn't care.
 */
import jsonpatch from 'fast-json-patch';
import type { Operation } from 'fast-json-patch';
import semver from 'semver';

const { compare } = jsonpatch;

import { Actor } from '../actor.js';
import { EventSourced } from '../event-sourced.js';
import { getHandlers, type HandlerFn } from '../handler.js';
import type { StorageDriver } from '../storage/driver.js';
import type { ActorId, ClassName, Version } from '../types/ids.js';

import {
  makeBridge,
  SILENT_LOGGER,
  type BridgeLogger,
  type BridgeOutbound,
} from './host-bridge.js';
import { ClassLoader } from './loader.js';
import { Mailbox, MailboxFullError } from './mailbox.js';

/* -------------------------------------------------------- Public types */

export interface ActorClassRegistration {
  readonly name: ClassName;
  readonly version: Version;
  readonly ctor: new () => Actor;
  /** Capacity of the mailbox. Defaults to 1024. */
  readonly mailboxCapacity?: number;
  /** Idle deactivation timer in ms. Defaults to 5 min. */
  readonly idleDeactivateMs?: number;
  /** Snapshot debounce window in ms (SWM only). Defaults to 250. */
  readonly snapshotDebounceMs?: number;
  /**
   * Snapshot every Nth event (ES only). Defaults to 100. A snapshot
   * is also force-flushed on `onDeactivate` regardless of this.
   */
  readonly snapshotEveryNEvents?: number;
  /**
   * `false` (default) — sticky: actors keep running the class
   * version they were created with. Older versions are loaded via
   * the `ClassLoader` on activation.
   * `true` — floating: every activation runs the registered version,
   * walking `migrate()` if the snapshot is older.
   */
  readonly floating?: boolean;
}

export interface ActorHostOptions {
  readonly registration: ActorClassRegistration;
  readonly driver: StorageDriver;
  readonly id: ActorId;
  /**
   * Called when the host self-deactivates after the idle timer fires.
   * The directory uses this to evict the host from its map.
   */
  readonly onIdleEvict?: (id: ActorId) => void;
  /** Test seam: settable clock. */
  readonly now?: () => number;
  /**
   * Loader used to fetch older class versions when a sticky actor
   * activates against a snapshot whose `class_version` predates the
   * registered version. Omit if the only version that ever runs is
   * the registered one (unit tests).
   */
  readonly loader?: ClassLoader;
  /**
   * Callbacks the per-instance bridge uses for outbound `call` /
   * `tell` / `scheduleAt`. Provided by the Directory when the
   * Runtime owns this host.
   */
  readonly outbound?: BridgeOutbound;
  /** Optional bridge logger. Default silent. */
  readonly log?: BridgeLogger;
  /** Capability issuer the bridge's `mintCapability` should use. */
  readonly capabilityIssuer?: import('../policy/capability.js').CapabilityIssuer;
  /** Auditor used by privileged lifecycle events (migration). */
  readonly auditor?: import('../audit/index.js').Auditor;
  /** Metrics registry; the host bumps event/snapshot counters. */
  readonly metrics?: import('../metrics/index.js').MetricsRegistry;
}

/* ------------------------------------------------------- Mailbox items */

type CallResolve = (value: unknown) => void;
type CallReject = (err: unknown) => void;

type MailboxItem =
  | {
      readonly kind: 'tell';
      readonly type: string;
      readonly payload: unknown;
      readonly inboxId: string;
    }
  | {
      readonly kind: 'call';
      readonly method: string;
      readonly args: unknown;
      readonly resolve: CallResolve;
      readonly reject: CallReject;
    };

const DEFAULT_MAILBOX_CAPACITY = 1024;
const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 250;
const DEFAULT_SNAPSHOT_EVERY_N_EVENTS = 100;

/**
 * Information emitted to each commit listener after a turn completes.
 * SWM actors deliver `patch` (RFC 6902); ES actors deliver `event`
 * with the appended events and the new head seq. `tombstone` is
 * emitted externally via `notifyTombstone()` when the actor is
 * deleted.
 */
export type CommitInfo =
  | { readonly kind: 'patch'; readonly patch: readonly Operation[]; readonly state: object }
  | {
      readonly kind: 'event';
      readonly events: readonly unknown[];
      readonly seq: bigint;
      readonly state: object;
    }
  | { readonly kind: 'tombstone' };

export type CommitListener = (info: CommitInfo) => void;

export class ManifestRegression extends Error {
  readonly persistedVersion: Version;
  readonly registeredVersion: Version;
  constructor(actorId: ActorId, className: ClassName, persisted: Version, registered: Version) {
    super(
      `actor ${actorId as string} (${className as string}) is persisted at ` +
        `${persisted as string} which is newer than the registered ` +
        `${registered as string}; refusing to run older code against newer state`,
    );
    this.name = 'ManifestRegression';
    this.persistedVersion = persisted;
    this.registeredVersion = registered;
  }
}

/* --------------------------------------------------------------- Host */

export class ActorHost {
  readonly id: ActorId;
  readonly className: ClassName;
  readonly version: Version;

  private readonly driver: StorageDriver;
  private readonly registration: ActorClassRegistration;
  private readonly mailboxCapacity: number;
  private readonly idleDeactivateMs: number;
  private readonly snapshotDebounceMs: number;
  private readonly snapshotEveryNEvents: number;
  private readonly onIdleEvict?: (id: ActorId) => void;
  private readonly now: () => number;

  private instance: Actor | null = null;
  private handlers: Record<string, HandlerFn> = {};
  private mailbox!: Mailbox<MailboxItem>;
  private workerPromise: Promise<void> | null = null;

  private isEs = false;
  private currentSeq = 0n;
  private eventsSinceSnapshot = 0;

  private snapshotTimer: NodeJS.Timeout | null = null;
  private snapshotDirty = false;

  private idleTimer: NodeJS.Timeout | null = null;
  private lastActiveAt = 0;

  private activating: Promise<void> | null = null;
  private deactivating: Promise<void> | null = null;
  private activated = false;
  private destroyed = false;

  /** Metrics surface. Phase 8 reads these. */
  metrics = {
    tellsHandled: 0n,
    callsHandled: 0n,
    tellsDropped: 0n,
    snapshotsWritten: 0n,
    handlerErrors: 0n,
    eventsAppended: 0n,
    eventsReplayed: 0n,
    migrationsApplied: 0n,
  };

  private readonly loader: ClassLoader | null;
  private readonly outbound: BridgeOutbound | null;
  private readonly bridgeLog: BridgeLogger;
  private readonly capabilityIssuer: import('../policy/capability.js').CapabilityIssuer | null;
  private readonly auditor: import('../audit/index.js').Auditor | null;
  private readonly promMetrics: import('../metrics/index.js').MetricsRegistry | null;
  /** The class version the activated instance is actually running. */
  private runningVersion: Version;
  /** sha256 of the running class source; used to release the loader refcount. */
  private runningSha: string | null = null;

  /** Subscribers attached via {@link onCommit}; called after each turn. */
  private readonly commitListeners = new Set<(info: CommitInfo) => void>();
  /** Pre-handler snapshot of SWM state, for JSON Patch diffing. */
  private prevStateCapture: object | null = null;

  constructor(options: ActorHostOptions) {
    this.id = options.id;
    this.className = options.registration.name;
    this.version = options.registration.version;
    this.driver = options.driver;
    this.registration = options.registration;
    this.mailboxCapacity = options.registration.mailboxCapacity ?? DEFAULT_MAILBOX_CAPACITY;
    this.idleDeactivateMs = options.registration.idleDeactivateMs ?? DEFAULT_IDLE_MS;
    this.snapshotDebounceMs =
      options.registration.snapshotDebounceMs ?? DEFAULT_SNAPSHOT_DEBOUNCE_MS;
    this.snapshotEveryNEvents =
      options.registration.snapshotEveryNEvents ?? DEFAULT_SNAPSHOT_EVERY_N_EVENTS;
    if (options.onIdleEvict) this.onIdleEvict = options.onIdleEvict;
    this.now = options.now ?? Date.now;
    this.loader = options.loader ?? null;
    this.outbound = options.outbound ?? null;
    this.bridgeLog = options.log ?? SILENT_LOGGER;
    this.capabilityIssuer = options.capabilityIssuer ?? null;
    this.auditor = options.auditor ?? null;
    this.promMetrics = options.metrics ?? null;
    // Default; resolveCtor() may overwrite this for sticky activations.
    this.runningVersion = this.version;
  }

  /* -------------------------------------------------------- Activation */

  async activate(): Promise<void> {
    if (this.activated) return;
    if (this.activating) return this.activating;
    this.activating = this.doActivate().finally(() => {
      this.activating = null;
    });
    return this.activating;
  }

  private async doActivate(): Promise<void> {
    if (this.destroyed) throw new Error(`ActorHost ${this.id as string} is destroyed`);

    this.mailbox = new Mailbox<MailboxItem>(this.mailboxCapacity);

    const snap = await this.driver.loadSnapshot(this.id);
    const persisted = snap?.version ?? null;
    const { ctor, runningVersion, willMigrateSnap } = await this.resolveCtor(persisted);
    this.runningVersion = runningVersion;

    this.instance = new ctor();
    this.instance.actor_id = this.id;
    this.isEs = this.instance instanceof EventSourced;
    // Stage-3 method decorators register via `addInitializer`, which runs
    // during construction. Read the registry only after the first
    // instantiation so subclasses have a chance to install themselves.
    this.handlers = getHandlers(ctor);

    // Per-instance bridge. Tests that don't pass `outbound` get a stub
    // that throws on cross-actor calls.
    this.instance.actjs = makeBridge({
      self: {
        id: this.id,
        class: this.className,
        version: this.runningVersion,
      },
      ...(this.outbound ? { outbound: this.outbound } : {}),
      log: this.bridgeLog,
      now: this.now,
      ...(this.capabilityIssuer ? { capabilityIssuer: this.capabilityIssuer } : {}),
      ...(this.auditor ? { auditor: this.auditor } : {}),
      ...(this.promMetrics ? { metrics: this.promMetrics } : {}),
    });

    let prevSnap: { state: unknown; version: Version } | null = null;
    if (snap) {
      this.instance.state = snap.state as object;
      this.currentSeq = snap.seq;
      if (willMigrateSnap) prevSnap = { state: snap.state, version: snap.version };
    } else {
      // Cold start. Register the actor row before any event writes so
      // appendEvents can locate it.
      await this.driver.registerActor(this.id, this.className, this.runningVersion);
      if (this.isEs) {
        const es = this.instance as EventSourced<object, unknown>;
        this.instance.state = es.initialState();
        this.currentSeq = 0n;
      }
      if (this.instance.onInit) await this.instance.onInit(undefined);
    }

    // Snapshot version mismatch → walk migrate() on the instance. The
    // prior snapshot is preserved at the retention sentinel seq = -1
    // so a bad migrate is rollback-able by an operator.
    if (prevSnap) {
      await this.migrateSnapshot(prevSnap.state, prevSnap.version);
    }

    // ES: replay events strictly after the snapshot's seq up to the head.
    if (this.isEs) {
      await this.replayEvents();
    }

    if (this.instance.onActivate) await this.instance.onActivate();

    this.activated = true;
    this.touch();
    this.workerPromise = this.workerLoop();

    // Replay durable inbox before opening to new traffic. New tells received
    // during replay are accepted normally (they'll enqueue after the replayed
    // items via the same FIFO mailbox).
    const pending = await this.driver.readPendingInbox(this.id, Number.MAX_SAFE_INTEGER);
    for (const r of pending) {
      this.mailbox.enqueue({
        kind: 'tell',
        type: r.entry.type,
        payload: r.entry.payload,
        inboxId: r.id,
      });
    }
  }

  /**
   * Decide which class version this activation runs and produce the
   * constructor. Encapsulates the sticky-vs-floating policy.
   */
  private async resolveCtor(persisted: Version | null): Promise<{
    ctor: new () => Actor;
    runningVersion: Version;
    willMigrateSnap: boolean;
  }> {
    const registered = this.version;
    const floating = this.registration.floating ?? false;

    if (!persisted) {
      return {
        ctor: this.registration.ctor,
        runningVersion: registered,
        willMigrateSnap: false,
      };
    }

    if ((persisted as string) === (registered as string)) {
      return {
        ctor: this.registration.ctor,
        runningVersion: registered,
        willMigrateSnap: false,
      };
    }

    // Persisted differs from registered.
    if (semver.gt(persisted as string, registered as string)) {
      throw new ManifestRegression(this.id, this.className, persisted, registered);
    }

    if (floating) {
      // Use the new code; the snapshot state will be migrated.
      return {
        ctor: this.registration.ctor,
        runningVersion: registered,
        willMigrateSnap: true,
      };
    }

    // Sticky: load the older version's ctor.
    if (!this.loader) {
      throw new Error(
        `actor ${this.id as string} is sticky at ${persisted as string} but the runtime is ` +
          `registered for ${registered as string} and no ClassLoader is configured`,
      );
    }
    const oldCtor = await this.loader.load(this.className, persisted);
    const sha = await this.loader.sha256For(this.className, persisted);
    if (sha) {
      this.loader.acquire(sha);
      this.runningSha = sha;
    }
    return {
      ctor: oldCtor,
      runningVersion: persisted,
      willMigrateSnap: false,
    };
  }

  /**
   * Walk events from `currentSeq + 1` to head, folding each through
   * `reduce`. If the replay distance is at least one snapshot
   * interval, write an opportunistic snapshot before opening to new
   * traffic — every subsequent cold start gets the shorter tail.
   */
  private async replayEvents(): Promise<void> {
    const es = this.instance as EventSourced<object, unknown>;
    const head = await this.driver.headEventSeq(this.id);
    if (head <= this.currentSeq) return;
    let replayed = 0;
    let state = es.state;
    for await (const record of this.driver.readEvents(this.id, this.currentSeq + 1n)) {
      let event: unknown = record.payload;
      // Per-event migration: if the event was appended under an older class
      // version and the class defines migrateEvent, transform it before
      // folding through reduce.
      if (es.migrateEvent && (record.classVersion as string) !== (this.version as string)) {
        event = es.migrateEvent(event, record.classVersion as string);
      }
      state = es.reduce(state, event);
      this.currentSeq = record.seq;
      replayed++;
    }
    es.state = state;
    this.metrics.eventsReplayed += BigInt(replayed);
    this.eventsSinceSnapshot = replayed;
    if (replayed >= this.snapshotEveryNEvents) {
      this.snapshotDirty = true;
      await this.flushSnapshot();
    }
  }

  /**
   * Snapshot-level migration: invoked when the persisted snapshot's
   * `class_version` differs from this class's registered version.
   * Saves the prior state to the retention slot (seq = -1) and runs
   * the user's pure `migrate(prevState, prevVersion)` to produce the
   * new shape. A subsequent flushSnapshot stamps the new version.
   */
  private async migrateSnapshot(prevState: unknown, prevVersion: Version): Promise<void> {
    if (!this.instance?.migrate) {
      // No user migrate function. Trust that the existing state is
      // forward-compatible. Stamp the new version on next flush.
      this.snapshotDirty = true;
      return;
    }
    // Retain the prior snapshot under the sentinel seq for the
    // configurable retention window (Phase 7.2 sweeps).
    await this.driver.saveSnapshot(this.id, {
      class: this.className,
      version: prevVersion,
      seq: -1n,
      state: prevState,
    });
    const newState = await this.instance.migrate(prevState, prevVersion as string);
    this.instance.state = newState;
    this.metrics.migrationsApplied++;
    this.snapshotDirty = true;
    await this.flushSnapshot();
    if (this.auditor) {
      await this.auditor.record({
        action: 'actor.migrated',
        target: `${this.className as string}:${this.id as string}`,
        principal: 'system',
        meta: {
          actorId: this.id as string,
          class: this.className as string,
          fromVersion: prevVersion as string,
          toVersion: this.runningVersion as string,
        },
      });
    }
  }

  /* ------------------------------------------------------- Deactivation */

  async deactivate(reason: 'idle' | 'shutdown' | 'destroyed'): Promise<void> {
    if (this.deactivating) return this.deactivating;
    if (!this.activated) return;
    this.deactivating = this.doDeactivate(reason).finally(() => {
      this.deactivating = null;
      this.activated = false;
    });
    return this.deactivating;
  }

  private async doDeactivate(_reason: string): Promise<void> {
    this.clearIdleTimer();
    this.mailbox.close();
    if (this.workerPromise) await this.workerPromise;

    // Force-flush any pending snapshot.
    this.clearSnapshotTimer();
    if (this.snapshotDirty) await this.flushSnapshot();

    if (this.instance?.onDeactivate) {
      try {
        await this.instance.onDeactivate();
      } catch (err) {
        this.metrics.handlerErrors++;
        console.error(`onDeactivate threw for ${this.id as string}:`, err);
      }
    }
    if (this.loader && this.runningSha) {
      this.loader.release(this.runningSha);
      this.runningSha = null;
    }
    this.instance = null;
    this.workerPromise = null;
  }

  /* -------------------------------------------------------------- Tell */

  async tell(type: string, payload: unknown): Promise<void> {
    if (this.destroyed) throw new Error(`ActorHost ${this.id as string} is destroyed`);
    if (!this.activated) await this.activate();
    const inboxId = await this.driver.appendInbox(this.id, { type, payload });
    const accepted = this.mailbox.enqueue({ kind: 'tell', type, payload, inboxId });
    if (!accepted) {
      // Over-cap: durable-then-drop. The entry is acked immediately so it
      // isn't replayed on next activate.
      this.metrics.tellsDropped++;
      await this.driver.ackInbox(this.id, [inboxId]);
      return;
    }
    this.touch();
  }

  /* -------------------------------------------------------------- Call */

  async call<R = unknown>(method: string, args: unknown): Promise<R> {
    if (this.destroyed) throw new Error(`ActorHost ${this.id as string} is destroyed`);
    if (!this.activated) await this.activate();
    if (this.mailbox.isFull()) throw new MailboxFullError();
    return new Promise<R>((resolve, reject) => {
      const item: MailboxItem = {
        kind: 'call',
        method,
        args,
        resolve: resolve as CallResolve,
        reject,
      };
      const ok = this.mailbox.enqueue(item);
      if (!ok) {
        reject(new MailboxFullError());
        return;
      }
      this.touch();
    });
  }

  /* ------------------------------------------------------- Worker loop */

  private async workerLoop(): Promise<void> {
    for (;;) {
      const item = await this.mailbox.dequeue();
      if (!item) return; // mailbox closed, queue drained
      await this.handle(item);
    }
  }

  private async handle(item: MailboxItem): Promise<void> {
    const handler = this.handlers[item.kind === 'call' ? item.method : item.type];
    if (!handler) {
      const err = new Error(
        `no handler for ${item.kind === 'call' ? item.method : item.type} on ${this.className as string}`,
      );
      if (item.kind === 'call') item.reject(err);
      else {
        // Tell with no handler: ack and drop. We don't have a great recovery
        // path; the alternative is leaving it in the inbox forever.
        await this.driver.ackInbox(this.id, [item.inboxId]).catch(() => undefined);
        this.metrics.handlerErrors++;
      }
      return;
    }
    // Capture state pre-handler for the JSON Patch diff if there are
    // SWM subscribers attached. Cheap when no listeners; we never
    // structured-clone in the no-subscriber path.
    if (!this.isEs && this.commitListeners.size > 0) {
      this.prevStateCapture = structuredClone(this.instance!.state);
    }
    try {
      const result = await handler.call(
        this.instance!,
        item.kind === 'call' ? item.args : item.payload,
      );
      if (this.isEs) {
        await this.commitEs(item, result);
      } else {
        await this.commitSwm(item, result);
      }
      this.touch();
    } catch (err) {
      this.metrics.handlerErrors++;
      if (item.kind === 'call') item.reject(err);
      else {
        // Failed tell handler: leave the inbox entry unacked so the next
        // activate replays it. (Phase 3.3 will add poison-message handling.)
      }
    }
  }

  private async commitSwm(item: MailboxItem, result: unknown): Promise<void> {
    if (item.kind === 'call') {
      this.metrics.callsHandled++;
      item.resolve(result);
    } else {
      this.metrics.tellsHandled++;
      await this.driver.ackInbox(this.id, [item.inboxId]);
    }
    this.scheduleSnapshot();
    // Emit a JSON Patch if anyone is listening and the handler
    // actually mutated state.
    if (this.prevStateCapture !== null) {
      const newState = this.instance!.state;
      const patch = compare(
        this.prevStateCapture as Record<string, unknown>,
        newState as Record<string, unknown>,
      );
      this.prevStateCapture = null;
      if (patch.length > 0) {
        this.emitCommit({ kind: 'patch', patch, state: newState });
      }
    }
  }

  /**
   * ES commit: the handler must have returned `E[]`. Append the
   * events atomically through the driver, fold them into state via
   * `reduce`, and bump `currentSeq`. An empty array is a legal
   * no-op commit — no seq change, no log write, no snapshot trigger.
   */
  private async commitEs(item: MailboxItem, result: unknown): Promise<void> {
    if (!Array.isArray(result)) {
      throw new Error(
        `ES handler for ${this.className as string} must return E[]; got ${typeof result}`,
      );
    }
    const events = result as unknown[];
    if (events.length === 0) {
      if (item.kind === 'call') {
        this.metrics.callsHandled++;
        item.resolve(events);
      } else {
        this.metrics.tellsHandled++;
        await this.driver.ackInbox(this.id, [item.inboxId]);
      }
      return;
    }

    const writes = events.map((e) => normalizeEvent(e));
    const append = await this.driver.appendEvents(this.id, writes);
    const es = this.instance as EventSourced<object, unknown>;
    let state = es.state;
    for (const e of events) state = es.reduce(state, e);
    es.state = state;
    this.currentSeq = append.seq;
    this.metrics.eventsAppended += BigInt(events.length);
    if (this.promMetrics) {
      for (let i = 0; i < events.length; i++) {
        this.promMetrics.recordEventAppend(this.className as string);
      }
    }
    this.eventsSinceSnapshot += events.length;
    // ANY append leaves state ahead of the last persisted snapshot.
    // Marking dirty here guarantees the deactivate flush captures the
    // trailing events even if they don't cross the threshold.
    this.snapshotDirty = true;

    if (item.kind === 'call') {
      this.metrics.callsHandled++;
      item.resolve(events);
    } else {
      this.metrics.tellsHandled++;
      await this.driver.ackInbox(this.id, [item.inboxId]);
    }

    // Emit raw events to ES subscribers.
    if (this.commitListeners.size > 0) {
      this.emitCommit({
        kind: 'event',
        events,
        seq: this.currentSeq,
        state: es.state,
      });
    }

    if (this.eventsSinceSnapshot >= this.snapshotEveryNEvents) {
      await this.flushSnapshot();
    }
  }

  /* --------------------------------------------------- Commit hooks */

  /** Register a listener invoked after every committed mailbox turn. */
  onCommit(listener: CommitListener): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  /** Currently-attached listener count. Test seam. */
  commitListenerCount(): number {
    return this.commitListeners.size;
  }

  /**
   * Externally notify subscribers that this actor has been
   * tombstoned. Called by the API layer right after
   * `driver.tombstoneActor`.
   */
  notifyTombstone(): void {
    this.emitCommit({ kind: 'tombstone' });
  }

  /** Read the current in-memory state — for the subscribe-snapshot path. */
  currentState(): unknown {
    return this.instance?.state ?? null;
  }

  /** Current head event seq (ES); 0 for SWM. */
  currentEventSeq(): bigint {
    return this.currentSeq;
  }

  private emitCommit(info: CommitInfo): void {
    for (const l of this.commitListeners) {
      try {
        l(info);
      } catch (err) {
        console.error(`commit listener for ${this.id as string} threw:`, err);
      }
    }
  }

  /* --------------------------------------------------------- Snapshots */

  /** SWM trailing-debounce scheduler. ES skips this entirely. */
  private scheduleSnapshot(): void {
    this.snapshotDirty = true;
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      void this.flushSnapshot().catch((err) => {
        this.metrics.handlerErrors++;
        console.error(`snapshot flush failed for ${this.id as string}:`, err);
      });
    }, this.snapshotDebounceMs);
    // Don't keep the event loop alive on a debounce timer alone.
    if (typeof this.snapshotTimer.unref === 'function') this.snapshotTimer.unref();
  }

  private clearSnapshotTimer(): void {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  private async flushSnapshot(): Promise<void> {
    if (!this.snapshotDirty || !this.instance) return;
    this.snapshotDirty = false;
    await this.driver.saveSnapshot(this.id, {
      class: this.className,
      version: this.runningVersion,
      seq: this.isEs ? this.currentSeq : 0n,
      state: this.instance.snapshot(),
    });
    this.metrics.snapshotsWritten++;
    this.promMetrics?.recordSnapshot(this.className as string);
    if (this.isEs) this.eventsSinceSnapshot = 0;
  }

  /* --------------------------------------------------------- Idle timer */

  private touch(): void {
    this.lastActiveAt = this.now();
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.deactivateForIdle();
    }, this.idleDeactivateMs);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async deactivateForIdle(): Promise<void> {
    if (this.deactivating || !this.activated) return;
    if (this.mailbox.size() > 0) {
      this.resetIdleTimer();
      return;
    }
    await this.deactivate('idle');
    if (this.onIdleEvict) this.onIdleEvict(this.id);
  }

  /* ----------------------------------------------- Lifecycle helpers */

  /** Wait until the mailbox queue is empty and any in-flight handler finishes. */
  async drain(): Promise<void> {
    if (!this.activated) return;
    while (this.mailbox.size() > 0) await tick();
    // After the loop, the worker may still be inside a handler. Give it a tick.
    await tick();
  }

  /** Force-deactivate (used by shutdown / tests). */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.activated) await this.deactivate('destroyed');
  }

  /** Test seam. */
  pendingMailboxSize(): number {
    return this.mailbox?.size() ?? 0;
  }
}

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/**
 * Normalize a value returned by an ES handler into the {type, payload}
 * shape `appendEvents` expects. Handlers may return either:
 *   - `{ type, payload, causationId? }` records (preferred, explicit), or
 *   - tagged unions like `{ type, ...rest }` (folded so `payload = rest`).
 */
function normalizeEvent(e: unknown): { type: string; payload: unknown } {
  if (!e || typeof e !== 'object') {
    throw new Error('ES event must be an object with a string `type` discriminant');
  }
  const rec = e as Record<string, unknown>;
  const type = rec['type'];
  if (typeof type !== 'string') {
    throw new Error('ES event missing string `type` discriminant');
  }
  if ('payload' in rec) {
    return { type, payload: rec['payload'] };
  }
  // Tagged-union style: peel off `type`, keep the rest as the payload.
  const { type: _ignore, ...rest } = rec;
  return { type, payload: rest };
}
