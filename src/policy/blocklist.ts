/**
 * In-memory capability blocklist.
 *
 * Maps `jti` → `expires-at-ms`. `isRevoked(jti)` returns true iff
 * the jti is present AND not yet past its `exp` (we GC expired
 * entries lazily on lookup so a long-running process doesn't grow
 * the map without bound).
 *
 * A PG-backed implementation lands in 7.1b; the in-memory class
 * is enough for unit tests and single-node deployments without
 * shared state. The shape (`isRevoked`, `revoke`, `unrevoke`) is
 * stable so a swap is a constructor change at the call site.
 */
export interface Blocklist {
  isRevoked(jti: string): boolean;
  revoke(jti: string, expiresAtMs: number): void;
  unrevoke(jti: string): void;
  size(): number;
}

export interface MemoryBlocklistOptions {
  /** Test seam: clock source. */
  readonly nowMs?: () => number;
}

export class MemoryBlocklist implements Blocklist {
  private readonly entries = new Map<string, number>();
  private readonly now: () => number;

  constructor(options: MemoryBlocklistOptions = {}) {
    this.now = options.nowMs ?? Date.now;
  }

  isRevoked(jti: string): boolean {
    const exp = this.entries.get(jti);
    if (exp === undefined) return false;
    if (this.now() >= exp) {
      this.entries.delete(jti);
      return false;
    }
    return true;
  }

  revoke(jti: string, expiresAtMs: number): void {
    if (expiresAtMs <= this.now()) return;
    this.entries.set(jti, expiresAtMs);
  }

  unrevoke(jti: string): void {
    this.entries.delete(jti);
  }

  size(): number {
    // Trigger lazy GC so callers can observe the trimmed size.
    const now = this.now();
    for (const [jti, exp] of this.entries) {
      if (now >= exp) this.entries.delete(jti);
    }
    return this.entries.size;
  }
}

/* ---------------------------------------------- Cached read seam */

export interface BlocklistCacheOptions {
  /** Underlying blocklist (e.g. PG-backed in 7.1b). */
  readonly source: Blocklist;
  /** Cache TTL in ms. Default 10 s. */
  readonly ttlMs?: number;
  /** Test seam. */
  readonly nowMs?: () => number;
}

/**
 * Wraps a {@link Blocklist} with a per-jti TTL cache. Useful when
 * the underlying source is remote (PG) and the hot-path policy
 * check would otherwise incur a database round-trip per request.
 *
 * Documented worst-case revocation lag: `ttlMs`. Pick a small value
 * (10 s) and accept that recently-revoked jtis may sneak through
 * for up to that window.
 */
export class CachedBlocklist implements Blocklist {
  private readonly source: Blocklist;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { revoked: boolean; checkedAt: number }>();

  constructor(options: BlocklistCacheOptions) {
    this.source = options.source;
    this.ttlMs = options.ttlMs ?? 10_000;
    this.now = options.nowMs ?? Date.now;
  }

  isRevoked(jti: string): boolean {
    const cached = this.cache.get(jti);
    const now = this.now();
    if (cached && now - cached.checkedAt < this.ttlMs) {
      return cached.revoked;
    }
    const revoked = this.source.isRevoked(jti);
    this.cache.set(jti, { revoked, checkedAt: now });
    return revoked;
  }

  revoke(jti: string, expiresAtMs: number): void {
    this.source.revoke(jti, expiresAtMs);
    // Invalidate the cache entry so the next read sees the new state.
    this.cache.delete(jti);
  }

  unrevoke(jti: string): void {
    this.source.unrevoke(jti);
    this.cache.delete(jti);
  }

  size(): number {
    return this.source.size();
  }
}
