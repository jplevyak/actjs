import type { ActorId, ClassName, Version } from './ids.js';

/** Strongly-typed reference to a specific class@version actor instance. */
export interface ActorRef {
  readonly id: ActorId;
  readonly class: ClassName;
  readonly version: Version;
}

/**
 * The wire envelope for every actor message — both inbound calls and
 * outbound events. One shape across REST, WS, and internal RPC.
 *
 * `manifestSha` is the sha of the resolved manifest the request is
 * pinned to; it propagates through every cross-actor hop so the call
 * stack stays consistent end-to-end.
 *
 * `causation` is the envelope id of the message that caused this one
 * (if any). It forms a tree across actor boundaries that traces can
 * follow.
 */
export interface Envelope<T = unknown> {
  /** UUIDv7 of this envelope. */
  readonly id: string;
  /** Wall-clock at the producer, ms since epoch. */
  readonly ts: number;
  readonly actor: ActorRef;
  /** Method name or event type. */
  readonly type: string;
  readonly payload: T;
  readonly idempotencyKey?: string;
  readonly causation?: string;
  readonly manifestSha: string;
}
