/**
 * Subscription registry.
 *
 * Owns the (actorId → subscribers) and (connection → subscriptions)
 * indexes for the WebSocket layer. Transport-agnostic: callers pass
 * a `sink` callback that the registry invokes with each notification,
 * so the same registry could back an SSE endpoint later.
 *
 * The registry calls `runtime.getHost()` to materialize the target
 * actor and attaches an `onCommit` listener via the host. When a
 * connection closes (or unsubscribes), the listener is detached.
 */
import { randomUUID } from 'node:crypto';

import type { ActorHost, CommitInfo } from '../runtime/host.js';
import type { Runtime } from '../runtime/index.js';
import type { ActorId, ClassName, Version } from '../types/ids.js';

/* -------------------------------------------------------- Public types */

export type SubscriberKind = 'snapshot' | 'patch' | 'event' | 'tombstone';

export interface SubscriberNotification {
  readonly subscriptionId: string;
  readonly kind: SubscriberKind;
  /** SWM: full state for `snapshot`; nothing for `patch` (use `patch` instead). ES: full state for `snapshot`. */
  readonly data?: unknown;
  /** SWM only: RFC 6902 patch ops since the last delivery. */
  readonly patch?: readonly unknown[];
  /** ES only: the events appended in this commit. */
  readonly events?: readonly unknown[];
  /** Head event seq for ES; 0 for SWM. */
  readonly seq?: string;
}

export type SubscriberSink = (notification: SubscriberNotification) => void;

export interface SubscribeResult {
  readonly subscriptionId: string;
}

export class SubscriberLimitError extends Error {
  readonly code = 'SubscriberLimit';
  constructor(actorId: ActorId, max: number) {
    super(`per-actor subscriber cap reached (${max}) for ${actorId as string}`);
    this.name = 'SubscriberLimitError';
  }
}

/* ------------------------------------------------------------- Impl */

interface Subscription {
  readonly id: string;
  readonly conn: object;
  readonly actorId: ActorId;
  readonly sink: SubscriberSink;
  detachFromHost: (() => void) | null;
}

export interface RegistryOptions {
  readonly maxPerActor?: number;
}

const DEFAULT_MAX_PER_ACTOR = 1000;

export class SubscriptionRegistry {
  private readonly subs = new Map<string, Subscription>();
  private readonly byActor = new Map<ActorId, Set<string>>();
  private readonly byConnection = new Map<object, Set<string>>();
  private readonly maxPerActor: number;

  /** Test seam. */
  notifications = 0n;

  constructor(
    private readonly runtime: Runtime,
    options: RegistryOptions = {},
  ) {
    this.maxPerActor = options.maxPerActor ?? DEFAULT_MAX_PER_ACTOR;
  }

  async subscribe(
    conn: object,
    className: ClassName,
    actorId: ActorId,
    sink: SubscriberSink,
  ): Promise<SubscribeResult> {
    const existing = this.byActor.get(actorId)?.size ?? 0;
    if (existing >= this.maxPerActor) {
      throw new SubscriberLimitError(actorId, this.maxPerActor);
    }

    const host = await this.runtime.getHost(className, actorId);
    const id = randomUUID();
    const subscription: Subscription = {
      id,
      conn,
      actorId,
      sink,
      detachFromHost: null,
    };

    // Attach the commit listener on the host first so the snapshot
    // delivered below is the upper bound of state the subscriber will
    // see — any commit BETWEEN snapshot and listener attach is lost.
    subscription.detachFromHost = host.onCommit((info) => this.deliver(subscription, info));

    this.subs.set(id, subscription);

    let actorSet = this.byActor.get(actorId);
    if (!actorSet) {
      actorSet = new Set();
      this.byActor.set(actorId, actorSet);
    }
    actorSet.add(id);

    let connSet = this.byConnection.get(conn);
    if (!connSet) {
      connSet = new Set();
      this.byConnection.set(conn, connSet);
    }
    connSet.add(id);

    // Initial snapshot — best effort. For SWM `state` is whatever
    // onInit/last-commit left in the instance; for ES it's the
    // reduced state at `currentSeq`.
    const initialState = host.currentState();
    const initialSeq = host.currentEventSeq();
    const initialKind: SubscriberKind = 'snapshot';
    sink({
      subscriptionId: id,
      kind: initialKind,
      data: initialState,
      seq: initialSeq.toString(),
    });
    this.notifications++;

    return { subscriptionId: id };
  }

  unsubscribe(subscriptionId: string): boolean {
    const sub = this.subs.get(subscriptionId);
    if (!sub) return false;
    this.detach(sub);
    return true;
  }

  /** Drop every subscription associated with this connection. */
  unsubscribeConnection(conn: object): void {
    const ids = this.byConnection.get(conn);
    if (!ids) return;
    for (const id of ids) {
      const sub = this.subs.get(id);
      if (sub) this.detach(sub);
    }
  }

  /** Currently-attached subscription count. Test seam. */
  size(): number {
    return this.subs.size;
  }

  private detach(sub: Subscription): void {
    sub.detachFromHost?.();
    this.subs.delete(sub.id);
    const a = this.byActor.get(sub.actorId);
    if (a) {
      a.delete(sub.id);
      if (a.size === 0) this.byActor.delete(sub.actorId);
    }
    const c = this.byConnection.get(sub.conn);
    if (c) {
      c.delete(sub.id);
      if (c.size === 0) this.byConnection.delete(sub.conn);
    }
  }

  private deliver(sub: Subscription, info: CommitInfo): void {
    const base = { subscriptionId: sub.id };
    let notif: SubscriberNotification;
    switch (info.kind) {
      case 'patch':
        notif = { ...base, kind: 'patch', patch: info.patch };
        break;
      case 'event':
        notif = {
          ...base,
          kind: 'event',
          events: info.events,
          seq: info.seq.toString(),
        };
        break;
      case 'tombstone':
        notif = { ...base, kind: 'tombstone' };
        // After tombstone there's nothing more to deliver — drop the
        // subscription right here.
        try {
          sub.sink(notif);
        } finally {
          this.detach(sub);
        }
        this.notifications++;
        return;
    }
    try {
      sub.sink(notif);
    } catch (err) {
      console.error(`subscriber sink threw for ${sub.id}:`, err);
    }
    this.notifications++;
  }
}

/** Re-export for convenience. */
export type { ActorHost, Version };
