import { describe, expect, it } from 'vitest';

import { RateLimitedError, RateLimiter } from '../../src/limits/index.js';
import { anonymousPrincipal, systemPrincipal } from '../../src/types/principal.js';

describe('RateLimiter', () => {
  it('lets a fresh principal through up to capacity', () => {
    const rl = new RateLimiter({ default: { capacity: 2, refillPerSec: 0 } });
    const p = { sub: 'user-1' };
    rl.enforce(p);
    rl.enforce(p);
    expect(() => rl.enforce(p)).toThrow(RateLimitedError);
  });

  it('returns a sensible Retry-After (seconds, >= 1)', () => {
    const rl = new RateLimiter({ default: { capacity: 1, refillPerSec: 0.5 } });
    const p = { sub: 'user-2' };
    rl.enforce(p);
    try {
      rl.enforce(p);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as RateLimitedError;
      expect(e).toBeInstanceOf(RateLimitedError);
      expect(e.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
  });

  it('honors role-specific overrides', () => {
    const rl = new RateLimiter({
      default: { capacity: 1, refillPerSec: 0 },
      perRole: { admin: { capacity: 100, refillPerSec: 0 } },
    });
    const admin = { sub: 'a', roles: ['admin'] };
    for (let i = 0; i < 50; i++) rl.enforce(admin);
    // A non-admin gets the default budget.
    const user = { sub: 'u' };
    rl.enforce(user);
    expect(() => rl.enforce(user)).toThrow(RateLimitedError);
  });

  it('exempts the system principal', () => {
    const rl = new RateLimiter({ default: { capacity: 1, refillPerSec: 0 } });
    for (let i = 0; i < 1000; i++) rl.enforce(systemPrincipal());
  });

  it('separately buckets anonymous traffic', () => {
    const rl = new RateLimiter({ default: { capacity: 1, refillPerSec: 0 } });
    rl.enforce(anonymousPrincipal());
    expect(() => rl.enforce(anonymousPrincipal())).toThrow(RateLimitedError);
  });
});
