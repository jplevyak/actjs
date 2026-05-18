import { describe, expect, it } from 'vitest';

import { k } from '../../src/storage/keys.js';
import { asActorId, asClassName, asVersion } from '../../src/types/index.js';

describe('valkey key names', () => {
  it('actor keys carry the id', () => {
    const id = asActorId('019080-test');
    expect(k.actorHot(id)).toBe('actor:019080-test:hot');
    expect(k.actorOwner(id)).toBe('actor:019080-test:owner');
    expect(k.actorFence(id)).toBe('actor:019080-test:fence');
    expect(k.actorInbox(id)).toBe('actor:019080-test:inbox');
    expect(k.actorMeta(id)).toBe('actor:019080-test:meta');
  });

  it('reminders key is a constant', () => {
    expect(k.reminders).toBe('reminders');
  });

  it('manifest cache key has the sha', () => {
    expect(k.manifestCache('abc123')).toBe('manifest:abc123');
    expect(k.manifestLastSeen('abc123')).toBe('manifest:abc123:lastSeen');
  });

  it('idempotency key has the request key', () => {
    expect(k.idempotency('req-9')).toBe('idem:req-9');
  });

  it('class keys carry name + version', () => {
    expect(k.classMeta(asClassName('Cart'))).toBe('class:Cart:meta');
    expect(k.classVersion(asClassName('Cart'), asVersion('1.4.2'))).toBe('class:Cart:v:1.4.2');
  });

  it('blob key has the sha', () => {
    expect(k.classBlob('deadbeef')).toBe('blob:deadbeef');
  });
});
