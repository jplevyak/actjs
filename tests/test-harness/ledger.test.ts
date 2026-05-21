/**
 * The classic event-sourced Ledger written entirely via `@actjs/test`.
 *
 * Exercises `assertEmitted` against the actor's event log.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventSourced } from '../../src/event-sourced.js';
import { handler } from '../../src/handler.js';
import {
  assertEmitted,
  assertSnapshot,
  TestRuntime,
  type TestActor,
} from '../../src/test/index.js';

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

let t: TestRuntime;
let ledger: TestActor;
beforeEach(async () => {
  t = await TestRuntime.create({ classes: { Ledger } });
  ledger = t.actor(Ledger);
});
afterEach(async () => {
  await t.close();
});

describe('TestRuntime — Ledger (event-sourced)', () => {
  it('records emitted events and updates state on reduce', async () => {
    await ledger.call.deposit({ amount: 10 });
    await ledger.call.deposit({ amount: 5 });
    await ledger.call.withdraw({ amount: 3 });
    await assertSnapshot(ledger, { balance: 12 });
    await assertEmitted(ledger, { type: 'Deposited', payload: { amount: 10 } });
    await assertEmitted(ledger, { type: 'Withdrawn', payload: { amount: 3 } });
  });

  it('withdraw beyond balance throws and emits no event', async () => {
    await ledger.call.deposit({ amount: 1 });
    await expect(ledger.call.withdraw({ amount: 99 })).rejects.toThrow('Insufficient balance');
    await assertSnapshot(ledger, { balance: 1 });
    await expect(
      assertEmitted(ledger, { type: 'Withdrawn', payload: { amount: 99 } }),
    ).rejects.toThrow(/assertEmitted/);
  });
});
