import { describe, expect, it, vi } from 'vitest';

import { StatusError } from '../src/error.js';
import GAct, { Actor, Aggregate, Replica, type RedisLike } from '../src/gact.js';

type MultiCall = { method: 'set'; key: string; value: string };

class FakeRedis implements RedisLike {
  store = new Map<string, string>();
  watched = new Set<string>();
  multiOps: MultiCall[][] = [];
  // When set, the next exec() call resolves to null (simulating a concurrent
  // modification to a watched key).
  failNextExec = false;

  async watch(key: string): Promise<string> {
    this.watched.add(key);
    return 'OK';
  }

  async unwatch(): Promise<string> {
    this.watched.clear();
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<string | null> {
    this.store.set(key, value);
    return 'OK';
  }

  multi() {
    const ops: MultiCall[] = [];
    this.multiOps.push(ops);
    const m = {
      set: (key: string, value: string) => {
        ops.push({ method: 'set', key, value });
        return m;
      },
      exec: async (): Promise<unknown[] | null> => {
        if (this.failNextExec) {
          this.failNextExec = false;
          return null;
        }
        for (const op of ops) {
          this.store.set(op.key, op.value);
        }
        this.watched.clear();
        return ops.map(() => 'OK');
      },
    };
    return m;
  }
}

describe('GAct constructor', () => {
  it('throws if no redis client is provided', () => {
    expect(() => new GAct(1, undefined as unknown as RedisLike)).toThrow(StatusError);
  });

  it('exposes the actor base classes', () => {
    const g = new GAct(1, new FakeRedis());
    expect(g.Actor).toBe(Actor);
    expect(g.Aggregate).toBe(Aggregate);
    expect(g.Replica).toBe(Replica);
  });
});

describe('Actor', () => {
  it('refuses to construct without a GAct', () => {
    expect(() => new Actor(undefined as unknown as GAct)).toThrow(StatusError);
  });

  it('registers itself in the GAct actors map', () => {
    const g = new GAct(1, new FakeRedis());
    const a = new Actor(g, 'a-1');
    expect(a.actor_id).toBe('a-1');
    expect(g.actors['a-1']).toBe(a);
  });

  it('generates a uuid if no id is given', () => {
    const g = new GAct(1, new FakeRedis());
    const a = new Actor(g);
    expect(a.actor_id).toMatch(/^[0-9a-f]{8}-/);
  });
});

describe('Replica', () => {
  it('sets save_replica = true', () => {
    const g = new GAct(1, new FakeRedis());
    const r = new Replica(g);
    expect(r['save_replica']).toBe(true);
  });
});

describe('fixupForSave', () => {
  it('returns primitives unchanged', () => {
    const g = new GAct(1, new FakeRedis());
    expect(g.fixupForSave(1)).toBe(1);
    expect(g.fixupForSave('s')).toBe('s');
    expect(g.fixupForSave(null)).toBe(null);
  });

  it('maps arrays recursively', () => {
    const g = new GAct(1, new FakeRedis());
    expect(g.fixupForSave([1, 'x', null])).toEqual([1, 'x', null]);
  });

  it('converts nested Actor instances into actor_id references', () => {
    const g = new GAct(1, new FakeRedis());
    const parent = new Actor(g, 'parent');
    const child = new Actor(g, 'child');
    parent['child'] = child;
    const saved = g.fixupForSave(parent) as Record<string, unknown>;
    expect(saved['child']).toEqual({ actor_id: 'child' });
    // gact back-reference and actor_id stays
    expect(saved['gact']).toBeUndefined();
    expect(saved['actor_id']).toBe('parent');
  });

  it('skips the save_replica sentinel field', () => {
    const g = new GAct(1, new FakeRedis());
    const r = new Replica(g, 'r');
    const saved = g.fixupForSave(r) as Record<string, unknown>;
    expect(saved['save_replica']).toBeUndefined();
  });
});

describe('save() with no changes', () => {
  it('unwatches and returns true without exec', async () => {
    const redis = new FakeRedis();
    const g = new GAct(1, redis);
    const ok = await g.save();
    expect(ok).toBe(true);
    // No multi op was committed (the multi was created but never used).
    const lastOps = redis.multiOps[redis.multiOps.length - 1];
    expect(lastOps).toEqual([]);
  });
});

describe('save() detects conflict', () => {
  it('returns false when exec resolves to null', async () => {
    const redis = new FakeRedis();
    const g = new GAct(1, redis);
    const a = new Actor(g, 'a');
    a['v'] = 1;
    redis.failNextExec = true;
    const ok = await g.save();
    expect(ok).toBe(false);
  });
});

describe('commit()', () => {
  it('short-circuits to true when aborted', async () => {
    const redis = new FakeRedis();
    const unwatch = vi.spyOn(redis, 'unwatch');
    const g = new GAct(1, redis);
    new Actor(g, 'a-not-saved');
    g.abort();
    const ok = await g.commit();
    expect(ok).toBe(true);
    expect(unwatch).toHaveBeenCalledOnce();
    // Even though we created an actor, no SET was issued because we aborted.
    expect(redis.store.size).toBe(0);
  });
});

describe('save() then load() round-trip', () => {
  it('persists an actor and reads it back through a new GAct', async () => {
    const redis = new FakeRedis();
    {
      const g = new GAct(1, redis);
      const a = new Actor(g, 'r1');
      a['hello'] = 'world';
      const ok = await g.save();
      expect(ok).toBe(true);
    }
    {
      const g = new GAct(2, redis);
      const loaded = await g.load('r1');
      expect(loaded).not.toBeNull();
      expect(loaded!['hello']).toBe('world');
      expect(loaded).toBeInstanceOf(Actor);
    }
  });

  it('round-trips nested actor references as lazy promises', async () => {
    const redis = new FakeRedis();
    {
      const g = new GAct(1, redis);
      const parent = new Actor(g, 'p');
      const child = new Actor(g, 'c');
      child['v'] = 42;
      parent['child'] = child;
      await g.save();
    }
    {
      const g = new GAct(2, redis);
      const p = await g.load('p');
      expect(p).not.toBeNull();
      const childRef = p!['child'];
      // Lazy refs surface as a Promise on first access.
      expect(childRef).toBeInstanceOf(Promise);
      const resolved = (await childRef) as Actor;
      expect(resolved['v']).toBe(42);
    }
  });
});

describe('read/write errors', () => {
  it('wraps redis errors as StatusError', async () => {
    const redis = new FakeRedis();
    redis.get = async () => {
      throw new Error('connection refused');
    };
    const g = new GAct(1, redis);
    await expect(g.read('x')).rejects.toBeInstanceOf(StatusError);
  });
});
