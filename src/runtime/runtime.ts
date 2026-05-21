/**
 * `Runtime`: the public surface that Phase 5 (HTTP routes) and the
 * Phase 8 test harness target. It owns the storage driver and the
 * directory, and exposes a small `tell` / `call` / `drain` /
 * `shutdown` API.
 */
import type { Actor } from '../actor.js';
import { AUDIT_ACTIONS, Auditor, NoopAuditor, type AuditorOptions } from '../audit/index.js';
import {
  CapacityExhaustedError,
  RateLimitedError,
  RateLimiter,
  type RateLimiterConfig,
} from '../limits/index.js';
import { makeNoopLogger, type Logger } from '../log/index.js';
import { MetricsRegistry, NoopMetricsRegistry } from '../metrics/index.js';
import type { CapabilityIssuer } from '../policy/capability.js';
import { evaluatePolicy, PolicyDeniedError, type PolicyAction } from '../policy/index.js';
import type { StorageDriver } from '../storage/driver.js';
import type { ActorId, ClassName, Version } from '../types/ids.js';
import {
  anonymousPrincipal,
  isSystem,
  systemPrincipal,
  type Principal,
} from '../types/principal.js';

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
  /**
   * Capability issuer used by `actjs.mintCapability` in handlers.
   * Omit to disable capability minting (the bridge method will throw
   * if called).
   */
  readonly capabilityIssuer?: CapabilityIssuer;
  /**
   * Audit subsystem. Passing an explicit `Auditor` overrides the
   * defaults; `auditOptions` only applies when one is built from
   * scratch. Pass `false` to disable auditing entirely (a no-op
   * recorder is used in its place).
   */
  readonly auditor?: Auditor | false;
  readonly auditOptions?: AuditorOptions;
  /**
   * Per-class active-actor cap. Negative or 0 = unlimited. The
   * directory consults this gauge before activating a new actor;
   * exceeding the cap raises a {@link CapacityExhaustedError}.
   */
  readonly activeActorCapPerClass?: number;
  /**
   * Per-principal rate limiter. Pass a `RateLimiter` instance or a
   * `RateLimiterConfig` to construct one. Omit to disable.
   */
  readonly rateLimiter?: RateLimiter | RateLimiterConfig;
  /**
   * Structured logger shared by the runtime + host bridge. Defaults
   * to a noop logger so tests that don't care don't have to wire one.
   */
  readonly log?: Logger;
  /**
   * Metrics registry. Pass a {@link MetricsRegistry} to enable
   * Prometheus collection across the runtime + hooks. Defaults to a
   * no-op registry so unrelated tests don't pay for label work.
   */
  readonly metrics?: MetricsRegistry;
  /**
   * Clock injected into the host bridge (so `actjs.now()` inside a
   * handler reads from here) and into the reminder dispatcher (so
   * `popDueReminders` sees the same time the handlers do). Tests
   * pass this for determinism; production omits it and reads
   * `Date.now()`.
   */
  readonly nowMs?: () => number;
}

export class Runtime {
  private readonly classes = new Map<ClassName, ActorClassRegistration>();
  private readonly directory: Directory;
  readonly reminderDispatcher: ReminderDispatcher;
  readonly loader: ClassLoader;
  readonly capabilityIssuer: CapabilityIssuer | null;
  readonly auditor: Auditor;
  readonly activeActorCapPerClass: number;
  readonly rateLimiter: RateLimiter | null;
  readonly log: Logger;
  readonly metrics: MetricsRegistry;

  constructor(
    private readonly driver: StorageDriver,
    options: RuntimeOptions = {},
  ) {
    this.loader = new ClassLoader(driver);
    this.capabilityIssuer = options.capabilityIssuer ?? null;
    this.activeActorCapPerClass = options.activeActorCapPerClass ?? 0;
    if (options.auditor === false) {
      this.auditor = new NoopAuditor();
    } else if (options.auditor) {
      this.auditor = options.auditor;
    } else {
      this.auditor = new Auditor(driver, options.auditOptions ?? {});
    }
    if (!options.rateLimiter) {
      this.rateLimiter = null;
    } else if (options.rateLimiter instanceof RateLimiter) {
      this.rateLimiter = options.rateLimiter;
    } else {
      this.rateLimiter = new RateLimiter(options.rateLimiter);
    }
    this.log = (options.log ?? makeNoopLogger()).child({ subsystem: 'runtime' });
    this.metrics = options.metrics ?? new NoopMetricsRegistry();
    this.directory = new Directory(
      driver,
      this.classes,
      this.loader,
      this.capabilityIssuer,
      this.auditor,
      this.activeActorCapPerClass,
      options.metrics ?? null,
      options.nowMs ?? null,
    );
    this.reminderDispatcher = new ReminderDispatcher(
      driver,
      async (className, actorId, type, payload) => {
        // Internal delivery — bypass policy.
        await this.tell(
          className as ClassName,
          actorId as ActorId,
          type,
          payload,
          systemPrincipal(),
        );
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
  async tell(
    className: ClassName,
    id: ActorId,
    type: string,
    payload: unknown,
    principal?: Principal,
  ): Promise<void> {
    const host = await this.directory.resolve(id, className);
    this.checkPolicy(className, principal, {
      kind: 'call',
      method: type,
      args: payload,
      actor: { ref: { class: className, id, version: host.version }, state: host.currentState() },
    });
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
    principal?: Principal,
  ): Promise<R> {
    const cls = className as string;
    try {
      this.enforceRateLimit(principal);
      const host = await this.directory.resolve(id, className);
      this.checkPolicy(className, principal, {
        kind: 'call',
        method,
        args,
        actor: { ref: { class: className, id, version: host.version }, state: host.currentState() },
      });
      const result = await host.call<R>(method, args);
      this.metrics.recordCall(cls, method, 'ok');
      return result;
    } catch (err) {
      if (err instanceof RateLimitedError) {
        this.metrics.recordCall(cls, method, 'rate_limited');
        this.metrics.recordRateLimitDrop(err.subject);
      } else if (err instanceof CapacityExhaustedError) {
        this.metrics.recordCall(cls, method, 'cap_exhausted');
        this.metrics.recordCapacityExhausted(err.className);
      } else if (err instanceof PolicyDeniedError) {
        this.metrics.recordCall(cls, method, 'denied');
      } else {
        this.metrics.recordCall(cls, method, 'error');
      }
      throw err;
    }
  }

  /** Internal: enforce the per-principal rate limit. */
  private enforceRateLimit(principal: Principal | undefined): void {
    if (!this.rateLimiter) return;
    this.rateLimiter.enforce(principal);
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
  async tombstone(id: ActorId, principal?: Principal): Promise<void> {
    const live = this.directory.getLive(id);
    let className: ClassName | undefined;
    if (live) {
      this.checkPolicy(live.className, principal, {
        kind: 'destroy',
        actor: {
          ref: { class: live.className, id, version: live.version },
          state: live.currentState(),
        },
      });
      className = live.className;
      live.notifyTombstone();
    }
    await this.driver.tombstoneActor(id);
    await this.auditor.record({
      action: AUDIT_ACTIONS.ACTOR_TOMBSTONED,
      target: `${(className ?? 'unknown') as string}:${id as string}`,
      principal: principal ?? anonymousPrincipal(),
      meta: { actorId: id as string, class: className as string | undefined },
    });
  }

  /**
   * Check a `read` policy for an actor's current state. The REST
   * snapshot route calls this without materializing through `call`,
   * so the policy gate runs even when the request is purely
   * read-only.
   */
  async checkRead(className: ClassName, id: ActorId, principal?: Principal): Promise<void> {
    const host = await this.directory.resolve(id, className);
    this.checkPolicy(className, principal, {
      kind: 'read',
      actor: { ref: { class: className, id, version: host.version }, state: host.currentState() },
    });
  }

  /**
   * Check a `create` policy. The REST create-actor route mints an
   * id without materializing, so the policy gate sees only the
   * create args.
   */
  checkCreate(className: ClassName, args: unknown, principal?: Principal): void {
    this.checkPolicy(className, principal, { kind: 'create', args });
  }

  /**
   * Internal: evaluate the class's `static policy()` for an action.
   * Throws `PolicyDeniedError` on deny. Unknown classes pass through
   * — the caller already failed before reaching here for those.
   */
  private checkPolicy(
    className: ClassName,
    principal: Principal | undefined,
    action: PolicyAction,
  ): void {
    const reg = this.classes.get(className);
    if (!reg) return;
    const effective = principal ?? anonymousPrincipal();
    // System principal is the runtime's "trust me" sentinel — used
    // by the reminder dispatcher and other internal call sites.
    if (isSystem(effective)) return;
    const decision = evaluatePolicy(reg.ctor, effective, action);
    this.metrics.recordPolicyDecision(className as string, decision.allow);
    if (!decision.allow) {
      const reason = decision.reason ?? 'policy denied';
      throw new PolicyDeniedError(
        `policy denied ${describeAction(action)} on ${className as string}: ${reason}`,
        reason,
      );
    }
  }

  /** Graceful shutdown: stop the dispatcher, deactivate every actor. */
  async shutdown(): Promise<void> {
    await this.reminderDispatcher.stop();
    await this.directory.shutdown();
  }
}

function describeAction(action: PolicyAction): string {
  switch (action.kind) {
    case 'call':
      return `call ${action.method}`;
    case 'read':
      return 'read';
    case 'create':
      return 'create';
    case 'destroy':
      return 'destroy';
  }
}
