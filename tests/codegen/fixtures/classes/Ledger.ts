/**
 * ES fixture: event union, reduce, one ES handler that returns events.
 * The reducer body is what gets transpiled into runtime.js.
 */
type LedgerEvent = { type: 'credit'; amount: number } | { type: 'debit'; amount: number };

class Ledger extends actjs.EventSourced<{ balance: number }, LedgerEvent> {
  reduce(state: { balance: number }, event: LedgerEvent): { balance: number } {
    if (event.type === 'credit') {
      return { balance: state.balance + event.amount };
    }
    return { balance: state.balance - event.amount };
  }

  @handler('credit')
  credit(args: { amount: number }): LedgerEvent[] {
    return [{ type: 'credit', amount: args.amount }];
  }
}
