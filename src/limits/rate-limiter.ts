/**
 * Per-principal rate limiter for `actor.call`.
 *
 * Each principal subject ("user:123", "cap:Note:abc", "anonymous")
 * gets its own token bucket. Roles can override the default capacity
 * + refill rate (e.g. `admin` gets a higher budget than the default
 * user). System principals are exempt.
 *
 * The limiter is per-process: in a multi-node deployment, each node
 * enforces its share of the budget independently. Phase 9 swaps in
 * a Valkey-backed shared counter; the interface stays the same so
 * call sites don't change.
 */
import { isSystem, type Principal } from '../types/principal.js';

import { RateLimitedError } from './errors.js';
import { TokenBucket, type TokenBucketConfig } from './token-bucket.js';

export interface RateLimiterConfig {
  /** Default budget applied to any principal without a role-specific override. */
  readonly default: TokenBucketConfig;
  /**
   * Per-role overrides. The first role on the principal that matches
   * the map is used; if none match the default applies.
   */
  readonly perRole?: Readonly<Record<string, TokenBucketConfig>>;
  /** Operation tag — surfaces in errors and metrics. Default `'actor.call'`. */
  readonly operation?: string;
  readonly nowMs?: () => number;
}

export interface RateLimitCheckResult {
  readonly ok: boolean;
  readonly retryAfterSeconds: number;
  readonly remaining: number;
  readonly bucket: string;
}

const DEFAULT_OPERATION = 'actor.call';

export class RateLimiter {
  private readonly defaultBucket: TokenBucket;
  private readonly roleBuckets: Map<string, TokenBucket>;
  private readonly operation: string;

  constructor(config: RateLimiterConfig) {
    const nowMs = config.nowMs;
    this.defaultBucket = new TokenBucket({
      config: config.default,
      ...(nowMs ? { nowMs } : {}),
    });
    this.roleBuckets = new Map();
    for (const [role, bucketCfg] of Object.entries(config.perRole ?? {})) {
      this.roleBuckets.set(
        role,
        new TokenBucket({ config: bucketCfg, ...(nowMs ? { nowMs } : {}) }),
      );
    }
    this.operation = config.operation ?? DEFAULT_OPERATION;
  }

  /**
   * Try to consume one token for the principal. Returns the check
   * result; the caller decides whether to throw — see {@link enforce}
   * for the throw-on-deny variant.
   */
  check(principal: Principal | undefined, cost = 1): RateLimitCheckResult {
    if (principal && isSystem(principal)) {
      return { ok: true, retryAfterSeconds: 0, remaining: Number.POSITIVE_INFINITY, bucket: '' };
    }
    const subject = subjectOf(principal);
    const bucket = this.bucketFor(principal);
    const result = bucket.try(subject, cost);
    return {
      ok: result.ok,
      retryAfterSeconds: Math.max(1, Math.ceil(result.retryAfterMs / 1000)),
      remaining: result.remaining,
      bucket: subject,
    };
  }

  /**
   * Enforce the limit: returns void on allow, throws {@link RateLimitedError}
   * on deny.
   */
  enforce(principal: Principal | undefined, cost = 1): void {
    const result = this.check(principal, cost);
    if (result.ok) return;
    throw new RateLimitedError(
      `rate limit exceeded for ${result.bucket}; retry after ${result.retryAfterSeconds}s`,
      result.bucket,
      this.operation,
      result.retryAfterSeconds,
    );
  }

  private bucketFor(principal: Principal | undefined): TokenBucket {
    const roles = principal?.roles ?? [];
    for (const role of roles) {
      const b = this.roleBuckets.get(role);
      if (b) return b;
    }
    return this.defaultBucket;
  }
}

function subjectOf(principal: Principal | undefined): string {
  if (!principal) return 'anonymous';
  return principal.sub;
}
