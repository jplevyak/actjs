import { describe, expect, it } from 'vitest';

import { Actor } from '../src/actor.js';
import { Replica } from '../src/replica.js';

interface ViewState {
  cachedAt: number;
  count: number;
}

class CartView extends Replica<ViewState> {}

describe('Replica', () => {
  it('persistOnDeactivate is false by default', () => {
    expect(CartView.persistOnDeactivate).toBe(false);
  });

  it('inherits from Actor', () => {
    const r = new CartView();
    expect(r).toBeInstanceOf(Actor);
  });

  it('snapshot still works for in-transaction reads', () => {
    const r = new CartView();
    r.state = { cachedAt: 1, count: 42 };
    expect(r.snapshot()).toEqual({ cachedAt: 1, count: 42 });
  });
});
