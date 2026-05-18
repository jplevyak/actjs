/**
 * In-process actor directory.
 *
 * Single-node v1: a Map<ActorId, ActorHost> with first-touch dedup
 * via a parallel `materializing` map. Phase 9 swaps this for a
 * consistent-hash placement + cross-node RPC; the public method
 * surface stays the same so call sites don't change.
 */
import type { StorageDriver } from '../storage/driver.js';
import type { ActorId, ClassName } from '../types/ids.js';

import { ActorHost, type ActorClassRegistration } from './host.js';

export class Directory {
  private hosts = new Map<ActorId, ActorHost>();
  private materializing = new Map<ActorId, Promise<ActorHost>>();
  private destroyed = false;

  constructor(
    private readonly driver: StorageDriver,
    private readonly classes: Map<ClassName, ActorClassRegistration>,
  ) {}

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
    const promise = (async () => {
      const host = new ActorHost({
        registration,
        driver: this.driver,
        id,
        onIdleEvict: (idleId) => this.evict(idleId),
      });
      await host.activate();
      return host;
    })();
    this.materializing.set(id, promise);
    try {
      const host = await promise;
      this.hosts.set(id, host);
      return host;
    } finally {
      this.materializing.delete(id);
    }
  }

  /** Remove an actor host without deactivating it (deactivate must already have run). */
  evict(id: ActorId): void {
    this.hosts.delete(id);
  }

  /** Currently-alive hosts (for metrics / `actctl actor inspect`). */
  liveCount(): number {
    return this.hosts.size;
  }

  liveIds(): readonly ActorId[] {
    return Array.from(this.hosts.keys());
  }

  /** Gracefully deactivate every host. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    // Wait for any in-flight materialization first.
    await Promise.allSettled(this.materializing.values());
    const hosts = Array.from(this.hosts.values());
    this.hosts.clear();
    await Promise.allSettled(hosts.map((h) => h.destroy()));
  }
}
