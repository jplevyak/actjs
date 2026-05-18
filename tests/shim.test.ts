import { describe, expect, it } from 'vitest';

import legacyDefault, {
  GAct,
  LegacyActor,
  LegacyAggregate,
  LegacyReplica,
} from '../src/legacy/shim.js';

describe('legacy shim', () => {
  it('re-exports the GAct constructor', () => {
    expect(typeof GAct).toBe('function');
    expect(GAct.name).toBe('GAct');
  });

  it('re-exports the legacy Actor / Aggregate / Replica classes', () => {
    expect(LegacyActor.name).toBe('Actor');
    expect(LegacyAggregate.name).toBe('Aggregate');
    expect(LegacyReplica.name).toBe('Replica');
  });

  it('preserves legacy inheritance', () => {
    expect(LegacyAggregate.prototype).toBeInstanceOf(LegacyActor);
    expect(LegacyReplica.prototype).toBeInstanceOf(LegacyActor);
  });

  it('default export is the GAct constructor', () => {
    expect(legacyDefault).toBe(GAct);
  });
});
