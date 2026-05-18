import { describe, expect, it } from 'vitest';

import { EventSourced } from '../src/event-sourced.js';
import { getHandlers, handler, type HandlerFn } from '../src/handler.js';

interface LedgerState {
  balance: number;
}

type LedgerEvent =
  | { readonly type: 'Deposited'; readonly amount: number }
  | { readonly type: 'Withdrawn'; readonly amount: number };

class Ledger extends EventSourced<LedgerState, LedgerEvent> {
  initialState(): LedgerState {
    return { balance: 0 };
  }

  reduce(state: LedgerState, event: LedgerEvent): LedgerState {
    switch (event.type) {
      case 'Deposited':
        return { balance: state.balance + event.amount };
      case 'Withdrawn':
        return { balance: state.balance - event.amount };
    }
  }

  @handler('deposit')
  deposit(args: { amount: number }): LedgerEvent[] {
    return [{ type: 'Deposited', amount: args.amount }];
  }

  @handler('withdraw')
  withdraw(args: { amount: number }): LedgerEvent[] {
    if (args.amount > this.state.balance) {
      throw new Error('Insufficient balance');
    }
    return [{ type: 'Withdrawn', amount: args.amount }];
  }
}

describe('EventSourced', () => {
  it('initialState is honored', () => {
    const l = new Ledger();
    l.state = l.initialState();
    expect(l.state.balance).toBe(0);
  });

  it('reduce applies events in order', () => {
    const l = new Ledger();
    let state = l.initialState();
    const events: LedgerEvent[] = [
      { type: 'Deposited', amount: 10 },
      { type: 'Deposited', amount: 5 },
      { type: 'Withdrawn', amount: 3 },
    ];
    for (const e of events) state = l.reduce(state, e);
    expect(state.balance).toBe(12);
  });

  it('reduce is pure (does not mutate input state)', () => {
    const l = new Ledger();
    const start: LedgerState = { balance: 100 };
    const next = l.reduce(start, { type: 'Withdrawn', amount: 25 });
    expect(start.balance).toBe(100);
    expect(next.balance).toBe(75);
  });

  it('handlers return events; state stays untouched until the runtime reduces', () => {
    const l = new Ledger();
    l.state = l.initialState();
    const deposit = getHandlers(Ledger)['deposit'] as HandlerFn<
      Ledger,
      [{ amount: number }],
      LedgerEvent[]
    >;
    const events = deposit.call(l, { amount: 10 }) as LedgerEvent[];
    expect(events).toEqual([{ type: 'Deposited', amount: 10 }]);
    // The handler does NOT touch state — the runtime applies events via reduce.
    expect(l.state.balance).toBe(0);
  });

  it('handlers can reject by throwing; no events to apply', () => {
    const l = new Ledger();
    l.state = l.initialState();
    const withdraw = getHandlers(Ledger)['withdraw'] as HandlerFn<
      Ledger,
      [{ amount: number }],
      LedgerEvent[]
    >;
    expect(() => withdraw.call(l, { amount: 5 })).toThrow(/Insufficient/);
    expect(l.state.balance).toBe(0);
  });

  it('cold-start: initial state + all events == replayed state', () => {
    const l = new Ledger();
    const allEvents: LedgerEvent[] = [
      { type: 'Deposited', amount: 100 },
      { type: 'Withdrawn', amount: 40 },
      { type: 'Deposited', amount: 5 },
    ];
    let s = l.initialState();
    for (const e of allEvents) s = l.reduce(s, e);
    expect(s.balance).toBe(65);
  });
});
