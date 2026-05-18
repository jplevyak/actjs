import { describe, expect, it } from 'vitest';

import { decodeSnapshot, encodeSnapshot, isOversizedSnapshot } from '../../src/storage/codec.js';

describe('snapshot codec', () => {
  it('round-trips primitive types', () => {
    expect(decodeSnapshot(encodeSnapshot(42))).toBe(42);
    expect(decodeSnapshot(encodeSnapshot('hi'))).toBe('hi');
    expect(decodeSnapshot(encodeSnapshot(null))).toBe(null);
  });

  it('round-trips structured state', () => {
    const state = {
      id: 'a-1',
      tags: ['x', 'y'],
      nested: { count: 7, active: true, list: [1, 2, 3] },
    };
    const bytes = encodeSnapshot(state);
    expect(decodeSnapshot(bytes)).toEqual(state);
  });

  it('flags oversized snapshots', () => {
    const big = encodeSnapshot({ blob: 'A'.repeat(200_000) });
    expect(isOversizedSnapshot(big)).toBe(false); // 'A'.repeat compresses very well
    const noisy = encodeSnapshot({
      blob: Array.from({ length: 200_000 }, () => Math.random().toString(36)).join(''),
    });
    expect(isOversizedSnapshot(noisy)).toBe(true);
  });

  it('produces gzip-prefixed output', () => {
    const bytes = encodeSnapshot({ a: 1 });
    // gzip magic bytes 0x1f 0x8b
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
  });
});
