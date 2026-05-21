/**
 * Prometheus metrics for actjs.
 *
 * One {@link MetricsRegistry} instance is built per process. The
 * server exposes its underlying `prom-client.Registry` at
 * `/metrics`. Each subsystem (runtime, audit, capabilities, rate
 * limits, manifest tracker) takes a `MetricsRegistry` reference and
 * calls the typed `inc*` / `set*` / `observe*` helpers — this keeps
 * the call sites cheap and provides one place to enforce
 * cardinality guards (method allow-list, `_other` bucket).
 */
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

import type { Logger } from '../log/index.js';

/** Default-allowed method label cardinality before falling back to `_other`. */
const DEFAULT_METHOD_LIMIT = 50;

export interface MetricsRegistryOptions {
  /** Register the standard Node + process collectors. Default `true`. */
  readonly collectDefault?: boolean;
  /** Max distinct method labels (per class) before bucketing into `_other`. */
  readonly methodLimit?: number;
  /** Optional logger; emits a single warn on the first allow-list overflow. */
  readonly log?: Logger;
  /** Existing `prom-client.Registry` to attach to (tests). */
  readonly registry?: Registry;
  /** Prefix prepended to every metric name. Default `'actjs_'`. */
  readonly prefix?: string;
}

const DEFAULT_PREFIX = 'actjs_';

type CallOutcome = 'ok' | 'error' | 'denied' | 'rate_limited' | 'cap_exhausted';

export class MetricsRegistry {
  readonly registry: Registry;
  private readonly methodLimit: number;
  private readonly methodsByClass = new Map<string, Set<string>>();
  private overflowWarned = false;
  private readonly log: Logger | undefined;

  readonly actorMessageTotal: Counter<string>;
  readonly actorMailboxDepth: Gauge<string>;
  readonly actorActive: Gauge<string>;
  readonly clientsByManifest: Gauge<string>;
  readonly manifestResolutionSeconds: Histogram<string>;
  readonly eventAppendTotal: Counter<string>;
  readonly eventSnapshotTotal: Counter<string>;
  readonly policyDecisionTotal: Counter<string>;
  readonly rateLimitDropTotal: Counter<string>;
  readonly capacityExhaustedTotal: Counter<string>;
  readonly capabilityMintedTotal: Counter<string>;

  constructor(options: MetricsRegistryOptions = {}) {
    this.registry = options.registry ?? new Registry();
    this.methodLimit = options.methodLimit ?? DEFAULT_METHOD_LIMIT;
    this.log = options.log;
    const prefix = options.prefix ?? DEFAULT_PREFIX;

    if (options.collectDefault !== false && !options.registry) {
      collectDefaultMetrics({ register: this.registry });
    }

    this.actorMessageTotal = new Counter({
      name: `${prefix}actor_message_total`,
      help: 'Actor messages handled, labeled by class, method, and outcome.',
      labelNames: ['class', 'method', 'outcome'],
      registers: [this.registry],
    });
    this.actorMailboxDepth = new Gauge({
      name: `${prefix}actor_mailbox_depth`,
      help: 'Sum of pending mailbox entries across active actors, by class.',
      labelNames: ['class'],
      registers: [this.registry],
    });
    this.actorActive = new Gauge({
      name: `${prefix}actor_active`,
      help: 'Currently-activated actor hosts, labeled by class and version.',
      labelNames: ['class', 'version'],
      registers: [this.registry],
    });
    this.clientsByManifest = new Gauge({
      name: `${prefix}clients_by_manifest`,
      help: 'Distinct clients seen per pinned manifest sha (sampled).',
      labelNames: ['sha'],
      registers: [this.registry],
    });
    this.manifestResolutionSeconds = new Histogram({
      name: `${prefix}manifest_resolution_seconds`,
      help: 'Time spent resolving a manifest sha.',
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
    this.eventAppendTotal = new Counter({
      name: `${prefix}event_append_total`,
      help: 'Events appended to the actor event log, by class.',
      labelNames: ['class'],
      registers: [this.registry],
    });
    this.eventSnapshotTotal = new Counter({
      name: `${prefix}event_snapshot_total`,
      help: 'Snapshots written, by class.',
      labelNames: ['class'],
      registers: [this.registry],
    });
    this.policyDecisionTotal = new Counter({
      name: `${prefix}policy_decision_total`,
      help: 'Policy decisions, by class and decision.',
      labelNames: ['class', 'decision'],
      registers: [this.registry],
    });
    this.rateLimitDropTotal = new Counter({
      name: `${prefix}rate_limit_drop_total`,
      help: 'Requests denied by the rate limiter, by principal subject.',
      labelNames: ['subject'],
      registers: [this.registry],
    });
    this.capacityExhaustedTotal = new Counter({
      name: `${prefix}capacity_exhausted_total`,
      help: 'Activations refused due to the active-actor cap, by class.',
      labelNames: ['class'],
      registers: [this.registry],
    });
    this.capabilityMintedTotal = new Counter({
      name: `${prefix}capability_minted_total`,
      help: 'Capability tokens minted by handlers, by minting class.',
      labelNames: ['class'],
      registers: [this.registry],
    });
  }

  /* ---------------------------------------- Cardinality-guarded helpers */

  /**
   * Record an actor.call result.
   *
   * `method` is run through the per-class allow-list: the first
   * `methodLimit` distinct methods seen are kept as-is; everything
   * beyond bucketizes to `_other`. The allow-list is rebuilt only
   * on process restart.
   */
  recordCall(className: string, method: string, outcome: CallOutcome): void {
    this.actorMessageTotal.inc(
      {
        class: className,
        method: this.bucketMethod(className, method),
        outcome,
      },
      1,
    );
  }

  /** Bump the gauge for a fresh activation. */
  recordActivation(className: string, version: string, delta: number): void {
    this.actorActive.inc({ class: className, version }, delta);
  }

  /** Set the gauge for a class's current mailbox depth. */
  setMailboxDepth(className: string, depth: number): void {
    this.actorMailboxDepth.set({ class: className }, depth);
  }

  /** Counter helpers — wrap label-set construction. */
  recordEventAppend(className: string): void {
    this.eventAppendTotal.inc({ class: className }, 1);
  }
  recordSnapshot(className: string): void {
    this.eventSnapshotTotal.inc({ class: className }, 1);
  }
  recordPolicyDecision(className: string, allowed: boolean): void {
    this.policyDecisionTotal.inc({ class: className, decision: allowed ? 'allow' : 'deny' }, 1);
  }
  recordRateLimitDrop(subject: string): void {
    this.rateLimitDropTotal.inc({ subject }, 1);
  }
  recordCapacityExhausted(className: string): void {
    this.capacityExhaustedTotal.inc({ class: className }, 1);
  }
  recordCapabilityMint(className: string): void {
    this.capabilityMintedTotal.inc({ class: className }, 1);
  }

  /** Snapshot the metrics in Prometheus text format. */
  async render(): Promise<string> {
    return this.registry.metrics();
  }

  /** Content type the `/metrics` route should send. */
  get contentType(): string {
    return this.registry.contentType;
  }

  private bucketMethod(className: string, method: string): string {
    let allowed = this.methodsByClass.get(className);
    if (!allowed) {
      allowed = new Set();
      this.methodsByClass.set(className, allowed);
    }
    if (allowed.has(method)) return method;
    if (allowed.size < this.methodLimit) {
      allowed.add(method);
      return method;
    }
    if (!this.overflowWarned) {
      this.overflowWarned = true;
      this.log?.warn('metrics: method-label cardinality cap hit; bucketing into "_other"', {
        class: className,
        limit: this.methodLimit,
        method,
      });
    }
    return '_other';
  }
}

/**
 * Build a no-op metrics surface — used when metrics are not wired.
 * Each `inc*` / `set*` is a cheap no-op so call sites can be
 * unconditional.
 */
export class NoopMetricsRegistry extends MetricsRegistry {
  constructor() {
    super({ registry: new Registry(), collectDefault: false });
  }

  override recordCall(): void {}
  override recordActivation(): void {}
  override setMailboxDepth(): void {}
  override recordEventAppend(): void {}
  override recordSnapshot(): void {}
  override recordPolicyDecision(): void {}
  override recordRateLimitDrop(): void {}
  override recordCapacityExhausted(): void {}
  override recordCapabilityMint(): void {}
}
