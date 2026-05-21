import { describe, expect, it } from 'vitest';

import { TokenBucket } from '../../src/limits/token-bucket.js';

describe('TokenBucket', () => {
  it('allows up to capacity then denies', () => {
    const now = 0;
    const b = new TokenBucket({ config: { capacity: 3, refillPerSec: 0 }, nowMs: () => now });
    expect(b.try('user').ok).toBe(true);
    expect(b.try('user').ok).toBe(true);
    expect(b.try('user').ok).toBe(true);
    const denied = b.try('user');
    expect(denied.ok).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it('refills over time', () => {
    const clock = { now: 0 };
    const b = new TokenBucket({
      config: { capacity: 2, refillPerSec: 2 },
      nowMs: () => clock.now,
    });
    expect(b.try('user').ok).toBe(true);
    expect(b.try('user').ok).toBe(true);
    expect(b.try('user').ok).toBe(false);
    clock.now = 600; // 0.6s * 2/s = 1.2 tokens
    expect(b.try('user').ok).toBe(true);
    expect(b.try('user').ok).toBe(false);
  });

  it('returns a retry-after time that lines up with the refill rate', () => {
    const now = 0;
    const b = new TokenBucket({ config: { capacity: 1, refillPerSec: 1 }, nowMs: () => now });
    b.try('user');
    const denied = b.try('user');
    expect(denied.ok).toBe(false);
    // 1 token short, 1 token/sec → ~1000 ms.
    expect(denied.retryAfterMs).toBeGreaterThanOrEqual(900);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(1100);
  });

  it('isolates buckets per subject', () => {
    const b = new TokenBucket({ config: { capacity: 1, refillPerSec: 0 } });
    expect(b.try('a').ok).toBe(true);
    expect(b.try('b').ok).toBe(true);
    expect(b.try('a').ok).toBe(false);
  });
});
