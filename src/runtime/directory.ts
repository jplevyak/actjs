/**
 * In-process actor directory.
 *
 * Single-node v1: a Map<ActorId, ActorHost> with first-touch dedup
 * via a parallel `materializing` map. Phase 9 swaps this for a
 * consistent-hash placement + cross-node RPC; the public method
 * surface stays the same so call sites don't change.
 */
import type { Auditor } from '../audit/index.js';
import { CapacityExhaustedError } from '../limits/errors.js';
import type { MetricsRegistry } from '../metrics/index.js';
import type { CapabilityIssuer } from '../policy/capability.js';
import type { StorageDriver } from '../storage/driver.js';
import type { ActorRef } from '../types/envelope.js';
import type { ActorId, ClassName } from '../types/ids.js';

import type { BridgeOutbound } from './host-bridge.js';
import { ActorHost, type ActorClassRegistration } from './host.js';
import type { ClassLoader } from './loader.js';

export class Directory {
  private hosts = new Map<ActorId, ActorHost>();
  private materializing = new Map<ActorId, Promise<ActorHost>>();
  private destroyed = false;
  private readonly outbound: BridgeOutbound;
  private readonly perClassActive = new Map<ClassName, number>();

  constructor(
    private readonly driver: StorageDriver,
    private readonly classes: Map<ClassName, ActorClassRegistration>,
    private readonly loader: ClassLoader,
    private readonly capabilityIssuer: CapabilityIssuer | null = null,
    private readonly auditor?: Auditor,
    private readonly activeActorCapPerClass: number = 0,
    private readonly metrics: MetricsRegistry | null = null,
    private readonly nowMs: (() => number) | null = null,
    private readonly onReminderScheduled: (() => void) | null = null,
  ) {
    // Arrow methods capture `this` lexically — no `const dir = this` alias.
    this.outbound = {
      call: async <R = unknown>(ref: ActorRef, method: string, args: unknown): Promise<R> => {
        const target = await this.resolve(ref.id, ref.class);
        return target.call<R>(method, args);
      },
      tell: async (ref: ActorRef, type: string, payload: unknown): Promise<void> => {
        const target = await this.resolve(ref.id, ref.class);
        await target.tell(type, payload);
      },
      scheduleAt: async (
        when: number,
        actorId: ActorId,
        className: ClassName,
        type: string,
        payload: unknown,
      ): Promise<void> => {
        await this.driver.enqueueReminder(when, {
          actorId,
          className,
          type,
          payload,
        });
        this.onReminderScheduled?.();
      },
    };
  }

  /**
   * Get (or materialize) the host for an actor of class `className`.
   *
   * Concurrent first-touch on a cold actor is deduplicated via the
   * `materializing` map: every concurrent caller awaits the same
   * activation promise.
   */
  async resolve(id: ActorId, className: ClassName): Promise<ActorHost> {
    if (this.destroyed) throw new Error('Directory is destroyed');
    const cached = this.hosts.get(id);
    if (cached) return cached;
    const inflight = this.materializing.get(id);
    if (inflight) return inflight;

    const registration = this.classes.get(className);
    if (!registration) {
      throw new Error(`unknown class: ${className as string}`);
    }
    this.checkActiveCap(className);
    const promise = (async () => {
      const host = new ActorHost({
        registration,
        driver: this.driver,
        id,
        onIdleEvict: (idleId) => this.evict(idleId),
        loader: this.loader,
        outbound: this.outbound,
        ...(this.capabilityIssuer ? { capabilityIssuer: this.capabilityIssuer } : {}),
        ...(this.auditor ? { auditor: this.auditor } : {}),
        ...(this.metrics ? { metrics: this.metrics } : {}),
        ...(this.nowMs ? { now: this.nowMs } : {}),
      });
      await host.activate();
      return host;
    })();
    this.materializing.set(id, promise);
    try {
      const host = await promise;
      this.hosts.set(id, host);
      this.bumpActive(className, +1);
      return host;
    } finally {
      this.materializing.delete(id);
    }
  }

  private checkActiveCap(className: ClassName): void {
    if (this.activeActorCapPerClass <= 0) return;
    const current = this.perClassActive.get(className) ?? 0;
    if (current >= this.activeActorCapPerClass) {
      throw new CapacityExhaustedError(
        `class ${className as string} has reached its active-actor cap (${this.activeActorCapPerClass})`,
        className as string,
        this.activeActorCapPerClass,
      );
    }
  }

  private bumpActive(className: ClassName, delta: number): void {
    const next = (this.perClassActive.get(className) ?? 0) + delta;
    if (next <= 0) this.perClassActive.delete(className);
    else this.perClassActive.set(className, next);
    if (this.metrics) {
      const reg = this.classes.get(className);
      this.metrics.recordActivation(className as string, (reg?.version ?? '') as string, delta);
    }
  }

  /** Active-actor count for a class. Used by metrics + the cap gauge. */
  activeCount(className: ClassName): number {
    return this.perClassActive.get(className) ?? 0;
  }

  /** Remove an actor host without deactivating it (deactivate must already have run). */
  evict(id: ActorId): void {
    const host = this.hosts.get(id);
    if (host) {
      this.bumpActive(host.className, -1);
      this.hosts.delete(id);
    }
  }

  /** Currently-alive hosts (for metrics / `actctl actor inspect`). */
  liveCount(): number {
    return this.hosts.size;
  }

  liveIds(): readonly ActorId[] {
    return Array.from(this.hosts.keys());
  }

  /** Currently-cached host, or null if not materialized. */
  getLive(id: ActorId): ActorHost | null {
    return this.hosts.get(id) ?? null;
  }

  /** Gracefully deactivate every host. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    // Wait for any in-flight materialization first.
    await Promise.allSettled(this.materializing.values());
    const hosts = Array.from(this.hosts.values());
    this.hosts.clear();
    this.perClassActive.clear();
    await Promise.allSettled(hosts.map((h) => h.destroy()));
  }
}
