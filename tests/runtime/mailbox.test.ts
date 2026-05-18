import { describe, expect, it } from 'vitest';

import { Mailbox, MailboxClosedError } from '../../src/runtime/mailbox.js';

describe('Mailbox', () => {
  it('rejects capacity < 1', () => {
    expect(() => new Mailbox(0)).toThrow();
  });

  it('enqueue + dequeue is FIFO', async () => {
    const m = new Mailbox<number>(8);
    m.enqueue(1);
    m.enqueue(2);
    m.enqueue(3);
    expect(await m.dequeue()).toBe(1);
    expect(await m.dequeue()).toBe(2);
    expect(await m.dequeue()).toBe(3);
  });

  it('reports full when at capacity', () => {
    const m = new Mailbox<number>(2);
    expect(m.enqueue(1)).toBe(true);
    expect(m.enqueue(2)).toBe(true);
    expect(m.isFull()).toBe(true);
    expect(m.enqueue(3)).toBe(false);
  });

  it('a waiting dequeue receives the next enqueue directly', async () => {
    const m = new Mailbox<string>(4);
    const waiting = m.dequeue();
    m.enqueue('hi');
    expect(await waiting).toBe('hi');
  });

  it('close releases all waiters with null', async () => {
    const m = new Mailbox<number>(4);
    const a = m.dequeue();
    const b = m.dequeue();
    m.close();
    expect(await a).toBeNull();
    expect(await b).toBeNull();
  });

  it('close while items remain lets dequeue drain them', async () => {
    const m = new Mailbox<number>(4);
    m.enqueue(1);
    m.enqueue(2);
    m.close();
    expect(await m.dequeue()).toBe(1);
    expect(await m.dequeue()).toBe(2);
    expect(await m.dequeue()).toBeNull();
  });

  it('enqueue after close throws', () => {
    const m = new Mailbox<number>(4);
    m.close();
    expect(() => m.enqueue(1)).toThrow(MailboxClosedError);
  });

  it('size + isFull track', () => {
    const m = new Mailbox<number>(2);
    expect(m.size()).toBe(0);
    m.enqueue(1);
    expect(m.size()).toBe(1);
    expect(m.isFull()).toBe(false);
    m.enqueue(2);
    expect(m.isFull()).toBe(true);
  });
});
