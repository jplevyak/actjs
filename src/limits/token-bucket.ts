/**
 * In-process token bucket.
 *
 * Each subject gets its own bucket. A bucket holds up to `capacity`
 * tokens; tokens refill at `refillTokensPerSec`. `try(subject, cost)`
 * deducts `cost` tokens; if the bucket is short, the call returns
 * `{ ok: false, retryAfterMs }`.
 *
 * The ADR locks the per-node implementation: rate limiting is
 * advisory across nodes (Phase 9 will move to a shared
 * Valkey-backed counter). The in-process bucket is fine for a
 * single-node deployment and for tests.
 */
export interface TokenBucketConfig {
  /** Maximum tokens the bucket can hold. */
  readonly capacity: number;
  /** Refill rate, tokens-per-second. */
  readonly refillPerSec: number;
}

export interface TokenBucketOptions {
  readonly config: TokenBucketConfig;
  readonly nowMs?: () => number;
  /** Idle bucket eviction window (ms). Default 10 min. */
  readonly idleEvictMs?: number;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export interface TokenBucketResult {
  readonly ok: boolean;
  readonly retryAfterMs: number;
  readonly remaining: number;
}

export class TokenBucket {
  private readonly buckets = new Map<string, BucketState>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly idleEvictMs: number;
  private lastGcAt = 0;

  constructor(options: TokenBucketOptions) {
    if (options.config.capacity <= 0) {
      throw new Error('token bucket capacity must be positive');
    }
    if (options.config.refillPerSec < 0) {
      throw new Error('token bucket refill rate must be non-negative');
    }
    this.capacity = options.config.capacity;
    this.refillPerMs = options.config.refillPerSec / 1000;
    this.now = options.nowMs ?? Date.now;
    this.idleEvictMs = options.idleEvictMs ?? 10 * 60 * 1000;
  }

  /** Try to consume `cost` tokens from the named bucket. */
  try(subject: string, cost = 1): TokenBucketResult {
    if (cost <= 0) {
      return { ok: true, retryAfterMs: 0, remaining: this.capacity };
    }
    const nowMs = this.now();
    this.maybeGc(nowMs);
    const state = this.peek(subject, nowMs);
    if (state.tokens >= cost) {
      state.tokens -= cost;
      return { ok: true, retryAfterMs: 0, remaining: Math.floor(state.tokens) };
    }
    const deficit = cost - state.tokens;
    const retryAfterMs =
      this.refillPerMs > 0 ? Math.ceil(deficit / this.refillPerMs) : Number.POSITIVE_INFINITY;
    return { ok: false, retryAfterMs, remaining: Math.floor(state.tokens) };
  }

  /** Current token count for a subject (recomputed with refill). */
  remaining(subject: string): number {
    const nowMs = this.now();
    return Math.floor(this.peek(subject, nowMs).tokens);
  }

  /** Bucket count (test seam). */
  size(): number {
    return this.buckets.size;
  }

  private peek(subject: string, nowMs: number): BucketState {
    let state = this.buckets.get(subject);
    if (!state) {
      state = { tokens: this.capacity, lastRefillMs: nowMs };
      this.buckets.set(subject, state);
      return state;
    }
    const elapsedMs = nowMs - state.lastRefillMs;
    if (elapsedMs > 0 && this.refillPerMs > 0) {
      const refill = elapsedMs * this.refillPerMs;
      state.tokens = Math.min(this.capacity, state.tokens + refill);
    }
    state.lastRefillMs = nowMs;
    return state;
  }

  private maybeGc(nowMs: number): void {
    if (nowMs - this.lastGcAt < this.idleEvictMs) return;
    this.lastGcAt = nowMs;
    for (const [subject, state] of this.buckets) {
      if (nowMs - state.lastRefillMs > this.idleEvictMs && state.tokens >= this.capacity - 1e-6) {
        this.buckets.delete(subject);
      }
    }
  }
}
