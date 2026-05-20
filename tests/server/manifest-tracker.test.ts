import { describe, expect, it } from 'vitest';

import { ManifestUsageTracker } from '../../src/server/manifest-tracker.js';

describe('ManifestUsageTracker', () => {
  it('counts repeated observations per sha', () => {
    let t = 1_000_000;
    const tracker = new ManifestUsageTracker({ now: () => t });
    tracker.record('a');
    t = 1_000_001;
    tracker.record('a');
    t = 1_000_002;
    tracker.record('b');

    const r = tracker.report();
    expect(r.entries.map((e) => [e.sha, e.count])).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
    expect(r.entries[0]?.lastSeen).toBe(1_000_001);
    expect(r.otherCount).toBe(0);
  });

  it('rolls extra shas into _other once cap is reached', () => {
    const tracker = new ManifestUsageTracker({ maxShas: 2 });
    tracker.record('a');
    tracker.record('b');
    tracker.record('c');
    tracker.record('d');
    const r = tracker.report();
    expect(r.entries.map((e) => e.sha).sort()).toEqual(['a', 'b']);
    expect(r.otherCount).toBe(2);
  });

  it('records resolved map on first observation', () => {
    const tracker = new ManifestUsageTracker();
    tracker.record('a', { Cart: '1.0.0' });
    tracker.record('a', { Cart: '9.9.9' });
    const entry = tracker.report().entries[0]!;
    expect(entry.resolved).toEqual({ Cart: '1.0.0' });
  });
});
