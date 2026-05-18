import { describe, expect, it } from 'vitest';

import { Actor } from '../src/actor.js';
import { getHandlers, handler, type HandlerFn } from '../src/handler.js';

interface CounterState {
  value: number;
}

class Counter extends Actor<CounterState> {
  @handler('increment')
  async increment(args: { by: number }): Promise<number> {
    this.state.value += args.by;
    return this.state.value;
  }

  @handler('reset')
  reset(): void {
    this.state.value = 0;
  }

  @handler() // defaults to method name
  read(): number {
    return this.state.value;
  }
}

describe('Actor.snapshot', () => {
  it('returns the current state by default', () => {
    const c = new Counter();
    c.state = { value: 7 };
    expect(c.snapshot()).toEqual({ value: 7 });
  });

  it('round-trips through JSON', () => {
    const c = new Counter();
    c.state = { value: 41 };
    const restored = JSON.parse(JSON.stringify(c.snapshot())) as CounterState;
    expect(restored.value).toBe(41);
  });
});

describe('@handler decorator', () => {
  it('registers handlers lazily on first instance', () => {
    new Counter();
    const handlers = getHandlers(Counter);
    expect(Object.keys(handlers).sort()).toEqual(['increment', 'read', 'reset']);
  });

  it('uses the method name when no explicit name is given', () => {
    new Counter();
    const handlers = getHandlers(Counter);
    expect(handlers['read']).toBeTypeOf('function');
  });

  it('preserves `this` when called via the registry', async () => {
    const c = new Counter();
    c.state = { value: 0 };
    const inc = getHandlers(Counter)['increment'] as HandlerFn<Counter, [{ by: number }], number>;
    const result = await inc.call(c, { by: 3 });
    expect(result).toBe(3);
    expect(c.state.value).toBe(3);
  });

  it('full tell round-trip: invoke → mutate → snapshot → restore', async () => {
    const c1 = new Counter();
    c1.state = { value: 0 };
    const inc = getHandlers(Counter)['increment'] as HandlerFn<Counter, [{ by: number }], number>;
    await inc.call(c1, { by: 5 });
    await inc.call(c1, { by: 2 });
    const json = JSON.stringify(c1.snapshot());

    const c2 = new Counter();
    c2.state = JSON.parse(json) as CounterState;
    expect(c2.state.value).toBe(7);
  });
});

describe('Handler registry across subclasses', () => {
  class Base extends Actor<{ n: number }> {
    @handler('inc')
    inc(): void {
      this.state.n++;
    }
  }
  class Child extends Base {
    @handler('dec')
    dec(): void {
      this.state.n--;
    }
  }

  it('child registry inherits parent handlers and adds its own', () => {
    new Base();
    new Child();
    expect(Object.keys(getHandlers(Base)).sort()).toEqual(['inc']);
    expect(Object.keys(getHandlers(Child)).sort()).toEqual(['dec', 'inc']);
  });

  it('subclass handlers do not leak into the parent registry', () => {
    new Base();
    new Child();
    expect(getHandlers(Base)['dec']).toBeUndefined();
  });
});
