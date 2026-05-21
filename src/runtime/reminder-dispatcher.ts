/**
 * Reminder dispatcher.
 *
 * Polls the storage driver every `tickMs` for due reminders and
 * delivers each one as a `tell` to its target actor. The dispatcher
 * is owned by `Runtime`; auto-starts on first `scheduleReminder` and
 * stops with `runtime.shutdown()`.
 *
 * Failures during delivery are logged but do not stop the loop —
 * Phase 7.2's poison-message handling will refine this. Re-delivery
 * after a dispatcher crash is handled by the storage layer (PG
 * mirror + Valkey ZADD on init).
 */
import type { StorageDriver } from '../storage/driver.js';

/** Function that delivers a reminder. The dispatcher calls this for every popped item. */
export type ReminderSink = (
  className: string,
  actorId: string,
  type: string,
  payload: unknown,
) => Promise<void>;

export interface ReminderDispatcherOptions {
  readonly tickMs?: number;
  readonly batchLimit?: number;
  /** Test seam: clock used when querying for due reminders. */
  readonly nowMs?: () => number;
}

const DEFAULT_TICK_MS = 100;
const DEFAULT_BATCH_LIMIT = 100;

export class ReminderDispatcher {
  private readonly tickMs: number;
  private readonly batchLimit: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private tickInFlight: Promise<void> | null = null;
  private stopped = false;
  /** Test seam: count of completed ticks. */
  ticks = 0n;
  /** Test seam: count of delivered reminders. */
  delivered = 0n;
  /** Test seam: count of delivery failures. */
  failures = 0n;

  constructor(
    private readonly driver: StorageDriver,
    private readonly sink: ReminderSink,
    options: ReminderDispatcherOptions = {},
  ) {
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
    this.now = options.nowMs ?? Date.now;
  }

  start(): void {
    if (this.stopped) return;
    if (this.timer) return;
    this.scheduleNextTick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.tickInFlight) {
      await this.tickInFlight.catch(() => undefined);
    }
  }

  /** Run one tick immediately. Test seam. */
  async tickOnce(): Promise<void> {
    await this.tick();
  }

  private scheduleNextTick(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tickInFlight = this.tick().finally(() => {
        this.tickInFlight = null;
        this.scheduleNextTick();
      });
    }, this.tickMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      for await (const msg of this.driver.popDueReminders(this.now(), this.batchLimit)) {
        try {
          await this.sink(msg.className, msg.actorId, msg.type, msg.payload);
          this.delivered++;
        } catch (err) {
          this.failures++;
          console.error(`reminder delivery failed for actor=${msg.actorId} type=${msg.type}:`, err);
        }
      }
    } catch (err) {
      this.failures++;
      console.error('reminder dispatcher tick error:', err);
    } finally {
      this.ticks++;
    }
  }
}
