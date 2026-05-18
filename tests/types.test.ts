import { describe, expect, it } from 'vitest';

import {
  asActorId,
  asClassName,
  asVersion,
  manifestFromEntries,
  manifestSha256,
  mkActorId,
  mkClassRef,
  type ActorId,
  type ClassName,
  type Manifest,
} from '../src/types/index.js';

describe('ids', () => {
  it('mkActorId returns a 36-char UUID string', () => {
    const id = mkActorId();
    expect(typeof id).toBe('string');
    expect(id.length).toBe(36);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('mkActorId returns time-ordered ids', () => {
    const a = mkActorId();
    const b = mkActorId();
    // UUIDv7 starts with 48 bits of unix-ms timestamp, so the
    // lexicographic order tracks creation order within a process.
    expect(a < b || a === b).toBe(true);
  });

  it('as* helpers brand strings without changing them at runtime', () => {
    const id: ActorId = asActorId('a-1');
    const cn: ClassName = asClassName('Cart');
    expect(id).toBe('a-1');
    expect(cn).toBe('Cart');
  });

  it('mkClassRef formats as Name@Version', () => {
    const ref = mkClassRef(asClassName('Cart'), asVersion('1.4.2'));
    expect(ref).toBe('Cart@1.4.2');
  });
});

describe('Manifest', () => {
  const cartV1 = manifestFromEntries([['Cart', '1.0.0']]);
  const cartV1AlsoItem = manifestFromEntries([
    ['Cart', '1.0.0'],
    ['Item', '2.3.4'],
  ]);

  it('manifestFromEntries brands keys & values', () => {
    const m: Manifest = cartV1;
    expect(m.size).toBe(1);
    // The brand is type-only — at runtime keys are still plain strings.
    expect(Array.from(m.keys())).toEqual(['Cart']);
  });

  it('manifestSha256 is deterministic', () => {
    expect(manifestSha256(cartV1AlsoItem)).toBe(manifestSha256(cartV1AlsoItem));
  });

  it('manifestSha256 is order-independent', () => {
    const m1 = manifestFromEntries([
      ['Cart', '1.0.0'],
      ['Item', '2.3.4'],
    ]);
    const m2 = manifestFromEntries([
      ['Item', '2.3.4'],
      ['Cart', '1.0.0'],
    ]);
    expect(manifestSha256(m1)).toBe(manifestSha256(m2));
  });

  it('manifestSha256 changes when content changes', () => {
    const m1 = manifestFromEntries([['Cart', '1.0.0']]);
    const m2 = manifestFromEntries([['Cart', '1.0.1']]);
    expect(manifestSha256(m1)).not.toBe(manifestSha256(m2));
  });

  it('manifestSha256 is 64 hex chars', () => {
    expect(manifestSha256(cartV1)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('manifestSha256 distinguishes versions', () => {
    const empty = manifestFromEntries([]);
    expect(manifestSha256(empty)).not.toBe(manifestSha256(cartV1));
  });
});
