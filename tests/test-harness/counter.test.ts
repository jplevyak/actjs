/**
 * The classic Counter example written entirely via `@actjs/test`.
 *
 * Exercises:
 *   - actor minting via `t.actor(Counter)`
 *   - call/tell dispatch through the proxy
 *   - snapshot assertions
 *   - reminder scheduling + `t.advanceTime` deterministic firing
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Actor } from '../../src/actor.js';
import { handler } from '../../src/handler.js';
import {
  assertScheduled,
  assertSnapshot,
  TestRuntime,
  type TestActor,
} from '../../src/test/index.js';

class Counter extends Actor<{ n: number }> {
  override onInit(): void {
    this.state = { n: 0 };
  }
  @handler('inc')
  inc(args: { by?: number } = {}): number {
    this.state.n += args.by ?? 1;
    return this.state.n;
  }
  @handler('read')
  read(): number {
    return this.state.n;
  }
  @handler('schedulePing')
  async schedulePing(args: { delayMs: number }): Promise<void> {
    await this.actjs!.scheduleAt(this.actjs!.now() + args.delayMs, 'ping', {});
  }
  @handler('ping')
  ping(): void {
    this.state.n += 100;
  }
}

let t: TestRuntime;
let counter: TestActor;

beforeEach(async () => {
  t = await TestRuntime.create({ classes: { Counter } });
  counter = t.actor(Counter);
});
afterEach(async () => {
  await t.close();
});

describe('TestRuntime — Counter', () => {
  it('mints fresh actors and dispatches call.<method>', async () => {
    const v = (await counter.call.inc({ by: 5 })) as number;
    expect(v).toBe(5);
    await assertSnapshot(counter, { n: 5 });
  });

  it('partial snapshot assertion ignores extra fields', async () => {
    await counter.call.inc({ by: 7 });
    await assertSnapshot(counter, { n: 7 }, { partial: true });
  });

  it('snapshot mismatch surfaces a readable error', async () => {
    await counter.call.inc({ by: 3 });
    await expect(assertSnapshot(counter, { n: 99 })).rejects.toThrow(/assertSnapshot mismatch/);
  });

  it('tell.<method> persists state without a return value', async () => {
    await counter.tell.inc({ by: 4 });
    await t.drain();
    await assertSnapshot(counter, { n: 4 });
  });

  it('scheduleAt + advanceTime fires the reminder', async () => {
    await counter.call.schedulePing({ delayMs: 1_000 });
    assertScheduled(t, { type: 'ping', actorId: counter.id as string });
    expect(await t.advanceTime(999)).toBe(0);
    await assertSnapshot(counter, { n: 0 });
    expect(await t.advanceTime(1)).toBe(1);
    await t.drain();
    await assertSnapshot(counter, { n: 100 });
  });
});

describe('multi-actor flows', () => {
  it('two counters maintain independent state', async () => {
    const a = t.actor(Counter);
    const b = t.actor(Counter);
    await a.call.inc({ by: 1 });
    await b.call.inc({ by: 9 });
    await assertSnapshot(a, { n: 1 });
    await assertSnapshot(b, { n: 9 });
  });
});
