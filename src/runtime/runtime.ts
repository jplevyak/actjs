/**
 * `Runtime`: the public surface that Phase 5 (HTTP routes) and the
 * Phase 8 test harness target. It owns the storage driver and the
 * directory, and exposes a small `tell` / `call` / `drain` /
 * `shutdown` API.
 */
import type { Actor } from '../actor.js';
import type { StorageDriver } from '../storage/driver.js';
import type { ActorId, ClassName, Version } from '../types/ids.js';

import { Directory } from './directory.js';
import { type ActorClassRegistration, type ActorHost } from './host.js';
import { ClassLoader } from './loader.js';
import { ReminderDispatcher, type ReminderDispatcherOptions } from './reminder-dispatcher.js';

export interface RegisterClassOptions {
  readonly name: ClassName;
  readonly version: Version;
  readonly ctor: new () => Actor;
  readonly mailboxCapacity?: number;
  readonly idleDeactivateMs?: number;
  /** SWM only: trailing-debounce window in ms. */
  readonly snapshotDebounceMs?: number;
  /** ES only: snapshot every N events (default 100). */
  readonly snapshotEveryNEvents?: number;
  /**
   * `true` to enable floating activation: every activate runs the
   * registered version and migrates older snapshots. Default `false`
   * (sticky — older actors load their original version via the
   * loader).
   */
  readonly floating?: boolean;
}

export interface RuntimeOptions {
  readonly reminders?: ReminderDispatcherOptions;
}

export class Runtime {
  private readonly classes = new Map<ClassName, ActorClassRegistration>();
  private readonly directory: Directory;
  readonly reminderDispatcher: ReminderDispatcher;
  readonly loader: ClassLoader;

  constructor(
    private readonly driver: StorageDriver,
    options: RuntimeOptions = {},
  ) {
    this.loader = new ClassLoader(driver);
    this.directory = new Directory(driver, this.classes, this.loader);
    this.reminderDispatcher = new ReminderDispatcher(
      driver,
      async (className, actorId, type, payload) => {
        await this.tell(className as ClassName, actorId as ActorId, type, payload);
      },
      options.reminders ?? {},
    );
  }

  /** Register a class for materialization. Idempotent on (name, version). */
  register(opts: RegisterClassOptions): void {
    const reg: ActorClassRegistration = {
      name: opts.name,
      version: opts.version,
      ctor: opts.ctor,
      ...(opts.mailboxCapacity !== undefined ? { mailboxCapacity: opts.mailboxCapacity } : {}),
      ...(opts.idleDeactivateMs !== undefined ? { idleDeactivateMs: opts.idleDeactivateMs } : {}),
      ...(opts.snapshotDebounceMs !== undefined
        ? { snapshotDebounceMs: opts.snapshotDebounceMs }
        : {}),
      ...(opts.snapshotEveryNEvents !== undefined
        ? { snapshotEveryNEvents: opts.snapshotEveryNEvents }
        : {}),
      ...(opts.floating !== undefined ? { floating: opts.floating } : {}),
    };
    this.classes.set(opts.name, reg);
  }

  /** Send a fire-and-forget message. Resolves once the entry is durable. */
  async tell(className: ClassName, id: ActorId, type: string, payload: unknown): Promise<void> {
    const host = await this.directory.resolve(id, className);
    await host.tell(type, payload);
  }

  /**
   * Schedule a `tell` for a future time. Auto-starts the dispatcher
   * loop on first call. The reminder survives a process restart
   * (via the storage layer's durable mirror); the dispatcher in the
   * next process pops and delivers when due.
   */
  async scheduleReminder(
    className: ClassName,
    id: ActorId,
    when: number | Date,
    type: string,
    payload: unknown,
  ): Promise<void> {
    const ms = typeof when === 'number' ? when : when.getTime();
    await this.driver.enqueueReminder(ms, {
      actorId: id,
      className,
      type,
      payload,
    });
    this.reminderDispatcher.start();
  }

  /** Request/response. Rejects with `MailboxFullError` if over the cap. */
  async call<R = unknown>(
    className: ClassName,
    id: ActorId,
    method: string,
    args: unknown,
  ): Promise<R> {
    const host = await this.directory.resolve(id, className);
    return await host.call<R>(method, args);
  }

  /** Wait for every live host's mailbox to drain. */
  async drain(): Promise<void> {
    const hosts = await Promise.all(this.directory.liveIds().map((id) => this.lookupLive(id)));
    await Promise.all(hosts.filter((h): h is ActorHost => !!h).map((h) => h.drain()));
  }

  private async lookupLive(id: ActorId): Promise<ActorHost | null> {
    // Resolve currently-cached host without materializing. We cheat through
    // the directory's `evict` API by looking up the class first; for v1 we
    // expose a `peek` helper instead.
    const ids = this.directory.liveIds();
    if (!ids.includes(id)) return null;
    // The directory's resolve will return the cached entry without re-activating.
    // We need the class name; pull it from the storage layer if needed.
    const snap = await this.driver.loadSnapshot(id);
    if (!snap) return null;
    return this.directory.resolve(id, snap.class);
  }

  /** Currently-active actor count. */
  liveCount(): number {
    return this.directory.liveCount();
  }

  /**
   * Materialize and return the actor host. Used by the subscription
   * registry to attach commit listeners; not intended for application
   * code, which should go through tell/call.
   */
  async getHost(className: ClassName, id: ActorId): Promise<ActorHost> {
    return this.directory.resolve(id, className);
  }

  /**
   * Tombstone an actor. Notifies any attached subscribers before the
   * driver-level tombstone so the WS clients see the `tombstone`
   * notification, then evicts the host.
   */
  async tombstone(id: ActorId): Promise<void> {
    const live = this.directory.getLive(id);
    if (live) live.notifyTombstone();
    await this.driver.tombstoneActor(id);
  }

  /** Graceful shutdown: stop the dispatcher, deactivate every actor. */
  async shutdown(): Promise<void> {
    await this.reminderDispatcher.stop();
    await this.directory.shutdown();
  }
}
