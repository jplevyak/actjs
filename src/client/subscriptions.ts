/**
 * Client-side subscription state.
 *
 * Each active subscription has a local `state` that the SDK keeps
 * in sync with the server's view by applying notifications:
 *
 *   - `snapshot`  — replace state.
 *   - `patch`     — apply RFC 6902 ops (SWM actors).
 *   - `event`     — fold through the supplied reducer (ES actors).
 *   - `tombstone` — emit a terminal notification and drop the sub.
 *
 * State is delivered to listeners as **immutable snapshots**: every
 * mutation produces a new top-level object. SWM updates use
 * `fast-json-patch`'s `applyPatch` with `mutateDocument: false` so
 * the previous snapshot stays addressable; ES updates rely on
 * reducers being pure (the same property the server enforces).
 */

import jsonpatch from 'fast-json-patch';
import type { Operation } from 'fast-json-patch';

import type { ActorEventNotification } from '../wire/index.js';

const { applyPatch } = jsonpatch;

export type SubscriptionListener<S = unknown> = (state: S) => void;

export type EsReducer<S = unknown, E = unknown> = (state: S, event: E) => S;

export interface SubscriptionRecord<S = unknown, E = unknown> {
  readonly subscriptionId: string;
  /** Current confirmed state. Replaced on every apply. */
  state: S;
  /** Highest server-confirmed seq, for ES replay-on-reconnect. */
  lastSeq: bigint;
  /** Pure ES reducer; only used when the class is event-sourced. */
  readonly reducer: EsReducer<S, E> | null;
  /** All listeners; called with the new state after each apply. */
  readonly listeners: Set<SubscriptionListener<S>>;
  /** True after a `tombstone` arrives. No further updates emit. */
  tombstoned: boolean;
}

export class SubscriptionState {
  private readonly subs = new Map<string, SubscriptionRecord>();
  /**
   * Notifications received before {@link register} ran. The server
   * delivers `snapshot` synchronously inside `subscribe()` before
   * returning the response, so the frame can arrive while the
   * client is still awaiting the RPC reply. Buffered entries are
   * flushed on the next `register` for the matching id and dropped
   * after ~5 s for safety.
   */
  private readonly pending = new Map<string, { entries: ActorEventNotification[]; at: number }>();
  private static readonly PENDING_TTL_MS = 5_000;

  register<S, E>(
    subscriptionId: string,
    reducer: EsReducer<S, E> | null,
  ): SubscriptionRecord<S, E> {
    const rec = this.preRegister<S, E>(subscriptionId, reducer);
    this.flushBuffered(subscriptionId);
    return rec;
  }

  /**
   * Register the record without applying any buffered notifications.
   * Use this when the caller wants to attach a listener before the
   * snapshot lands — call {@link flushBuffered} once the listener
   * is in place.
   */
  preRegister<S, E>(
    subscriptionId: string,
    reducer: EsReducer<S, E> | null,
  ): SubscriptionRecord<S, E> {
    const rec: SubscriptionRecord<S, E> = {
      subscriptionId,
      state: undefined as unknown as S,
      lastSeq: 0n,
      reducer,
      listeners: new Set(),
      tombstoned: false,
    };
    this.subs.set(subscriptionId, rec as unknown as SubscriptionRecord);
    return rec;
  }

  /** Replay buffered notifications for `subscriptionId`, if any. */
  flushBuffered(subscriptionId: string): void {
    const buffered = this.pending.get(subscriptionId);
    if (!buffered) return;
    this.pending.delete(subscriptionId);
    for (const n of buffered.entries) this.apply(n);
  }

  unregister(subscriptionId: string): void {
    this.subs.delete(subscriptionId);
  }

  get(subscriptionId: string): SubscriptionRecord | undefined {
    return this.subs.get(subscriptionId);
  }

  /** Convenience: list subscriptions for diagnostics. */
  size(): number {
    return this.subs.size;
  }

  /** Apply an inbound `actor.event` notification. */
  apply(notification: ActorEventNotification): void {
    const rec = this.subs.get(notification.subscriptionId);
    if (!rec) {
      // Buffer for a short window — the register call is likely
      // still resolving its RPC response.
      this.bufferEarly(notification);
      return;
    }
    if (rec.tombstoned) return;
    switch (notification.kind) {
      case 'snapshot':
        rec.state = notification.data;
        if (notification.seq !== undefined) {
          try {
            rec.lastSeq = BigInt(notification.seq);
          } catch {
            // ignore — non-numeric seq
          }
        }
        break;
      case 'patch': {
        const patch = (notification.patch ?? []) as Operation[];
        // Immutable apply: pass the *current* state and let jsonpatch
        // return the new document. The library's `mutateDocument:
        // false` flag and `newDocument` return keep prior snapshots
        // intact for consumers holding them.
        const next = applyPatch(rec.state, patch, /*validate*/ false, /*mutate*/ false).newDocument;
        rec.state = next;
        break;
      }
      case 'event': {
        if (!rec.reducer) {
          // ES events delivered without a reducer = misconfigured.
          // Apply by replacing with the data (server hint), else skip.
          if (notification.data !== undefined) rec.state = notification.data;
          break;
        }
        const events = (notification.events ?? []) as unknown[];
        let next = rec.state;
        for (const e of events) next = rec.reducer(next, e);
        rec.state = next;
        if (notification.seq !== undefined) {
          try {
            rec.lastSeq = BigInt(notification.seq);
          } catch {
            // ignore
          }
        }
        break;
      }
      case 'tombstone':
        rec.tombstoned = true;
        break;
    }
    for (const listener of rec.listeners) listener(rec.state);
  }

  /** Drop all subs (called on destroy). */
  clear(): void {
    this.subs.clear();
    this.pending.clear();
  }

  private bufferEarly(notification: ActorEventNotification): void {
    const now = Date.now();
    // Sweep expired buffers cheaply on every miss.
    for (const [id, buf] of this.pending) {
      if (now - buf.at > SubscriptionState.PENDING_TTL_MS) this.pending.delete(id);
    }
    let entry = this.pending.get(notification.subscriptionId);
    if (!entry) {
      entry = { entries: [], at: now };
      this.pending.set(notification.subscriptionId, entry);
    }
    entry.entries.push(notification);
  }
}
