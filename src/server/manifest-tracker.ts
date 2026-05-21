/**
 * In-process tracker for which client manifest shas have been seen
 * recently. Phase 8.1 exposes the data as a Prometheus
 * `clients_by_manifest{sha}` gauge; for Phase 4.3 we expose it via
 * an admin endpoint so `actctl manifest in-use` (Phase 8.2) has
 * something to query.
 *
 * Top-N capped: once `maxShas` distinct shas have been seen, every
 * subsequent unknown sha rolls up to the `_other` bucket. Counters
 * for the tracked shas remain accurate; only the breakdown beyond
 * the cap is lost. Operators see "you have an unbounded long tail"
 * by watching the `_other` bucket grow.
 */

const DEFAULT_MAX_SHAS = 128;
const OTHER_BUCKET = '_other';

export interface ManifestUsageEntry {
  readonly sha: string;
  readonly count: number;
  /** Epoch ms of the most recent request that carried this sha. */
  readonly lastSeen: number;
  /** Resolved version map, when known. */
  readonly resolved?: Readonly<Record<string, string>>;
}

export interface ManifestUsageReport {
  readonly entries: readonly ManifestUsageEntry[];
  readonly otherCount: number;
  readonly otherLastSeen: number;
}

export interface ManifestUsageTrackerOptions {
  readonly maxShas?: number;
  /** Test seam: settable clock. */
  readonly now?: () => number;
  /**
   * Optional metrics registry; the tracker updates the
   * `clients_by_manifest{sha}` gauge alongside its internal counters.
   */
  readonly metrics?: import('../metrics/index.js').MetricsRegistry;
}

interface Entry {
  count: number;
  lastSeen: number;
  resolved?: Readonly<Record<string, string>>;
}

export class ManifestUsageTracker {
  private readonly entries = new Map<string, Entry>();
  private readonly maxShas: number;
  private readonly now: () => number;
  private readonly metrics: import('../metrics/index.js').MetricsRegistry | undefined;
  private other = { count: 0, lastSeen: 0 };

  constructor(options: ManifestUsageTrackerOptions = {}) {
    this.maxShas = options.maxShas ?? DEFAULT_MAX_SHAS;
    this.now = options.now ?? Date.now;
    this.metrics = options.metrics;
  }

  /**
   * Record a request that pinned to `sha`. `resolved` is optional
   * metadata that helps operators identify the pin without consulting
   * storage; the tracker only updates it on the first observation per
   * sha (sources of truth are immutable in storage).
   */
  record(sha: string, resolved?: Readonly<Record<string, string>>): void {
    const existing = this.entries.get(sha);
    if (existing) {
      existing.count++;
      existing.lastSeen = this.now();
      this.metrics?.clientsByManifest.set({ sha }, existing.count);
      return;
    }
    if (this.entries.size >= this.maxShas) {
      this.other.count++;
      this.other.lastSeen = this.now();
      this.metrics?.clientsByManifest.set({ sha: OTHER_BUCKET }, this.other.count);
      return;
    }
    const entry: Entry = {
      count: 1,
      lastSeen: this.now(),
      ...(resolved ? { resolved } : {}),
    };
    this.entries.set(sha, entry);
    this.metrics?.clientsByManifest.set({ sha }, 1);
  }

  /** Snapshot of the current report. */
  report(): ManifestUsageReport {
    const entries: ManifestUsageEntry[] = [];
    for (const [sha, entry] of this.entries) {
      entries.push({
        sha,
        count: entry.count,
        lastSeen: entry.lastSeen,
        ...(entry.resolved ? { resolved: entry.resolved } : {}),
      });
    }
    // Descending by count, then by lastSeen as a tiebreaker.
    entries.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.lastSeen - a.lastSeen;
    });
    return {
      entries,
      otherCount: this.other.count,
      otherLastSeen: this.other.lastSeen,
    };
  }

  /** Convenience helper for tests. */
  size(): number {
    return this.entries.size;
  }

  /** Convenience: how many distinct shas are tracked + `_other`. */
  static readonly OTHER = OTHER_BUCKET;
}
