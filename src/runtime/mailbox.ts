/**
 * Bounded single-consumer mailbox for an actor host.
 *
 * Producers call {@link enqueue}; the single consumer awaits
 * {@link dequeue} in a loop. Once {@link close} is invoked the queue
 * drains and `dequeue` returns `null`. Once {@link drain} is invoked
 * dequeue stops yielding new items immediately (the worker exits) —
 * used for forced shutdown.
 *
 * Capacity is checked synchronously inside `enqueue`. Callers that
 * need backpressure semantics inspect `size()` themselves; this class
 * does not block enqueues.
 */

export class MailboxClosedError extends Error {
  constructor() {
    super('mailbox is closed');
    this.name = 'MailboxClosedError';
  }
}

export class MailboxFullError extends Error {
  constructor() {
    super('mailbox is full');
    this.name = 'MailboxFullError';
  }
}

export class Mailbox<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: ((item: T | null) => void)[] = [];
  private closed = false;

  constructor(public readonly capacity: number) {
    if (capacity < 1) throw new Error('Mailbox capacity must be ≥ 1');
  }

  size(): number {
    return this.buffer.length;
  }

  isFull(): boolean {
    return this.buffer.length >= this.capacity;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Returns `false` if the queue is at capacity (caller chooses
   * drop / retry / reject). Throws `MailboxClosedError` if the
   * queue has been closed.
   */
  enqueue(item: T): boolean {
    if (this.closed) throw new MailboxClosedError();
    if (this.waiters.length > 0) {
      this.waiters.shift()!(item);
      return true;
    }
    if (this.buffer.length >= this.capacity) return false;
    this.buffer.push(item);
    return true;
  }

  /**
   * Resolves to the next item, or `null` once the queue is both
   * closed and empty. A waiter is also resolved with `null` if the
   * queue is closed while it's blocked.
   */
  dequeue(): Promise<T | null> {
    if (this.buffer.length > 0) {
      return Promise.resolve(this.buffer.shift()!);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise<T | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Stop accepting new items; let the consumer drain whatever's queued. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Wake any consumer waiting on an empty queue.
    for (const w of this.waiters) w(null);
    this.waiters.length = 0;
  }
}
