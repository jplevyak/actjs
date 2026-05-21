/**
 * Public entry point for the limits module.
 */
export { CapacityExhaustedError, RateLimitedError } from './errors.js';
export { RateLimiter, type RateLimitCheckResult, type RateLimiterConfig } from './rate-limiter.js';
export {
  TokenBucket,
  type TokenBucketConfig,
  type TokenBucketOptions,
  type TokenBucketResult,
} from './token-bucket.js';
