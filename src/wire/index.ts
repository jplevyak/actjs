/**
 * Wire types shared between the actjs server and `@actjs/client`.
 *
 * These describe the JSON-RPC 2.0 envelope used over the WebSocket
 * transport (`/v1/ws`) and the notification shape used by both WS
 * and SSE. The server and the SDK both import from here so the
 * protocol has a single source of truth.
 *
 * REST request/response bodies are not in this file — those are
 * already typed at the route level via Zod schemas (Phase 5.1) and
 * exposed via OpenAPI. The SDK reuses the Zod-inferred types
 * directly where it talks REST.
 */

/* ---------------------------------------------------- JSON-RPC envelope */

export type JsonRpcId = number | string;

export interface JsonRpcRequest<P = unknown> {
  readonly jsonrpc: '2.0';
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result: R;
}

export interface JsonRpcError {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export interface JsonRpcNotification<P = unknown> {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params: P;
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcError;

/* ---------------------------------------------- Standard error codes */

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;
/** actjs framework-band: framework-defined errors (e.g. SubscriberLimit). */
export const ACTJS_FRAMEWORK_ERROR = -32000;

/* ----------------------------------------------- actor.* methods */

export interface ActorCallParams {
  readonly class: string;
  readonly id: string;
  readonly method: string;
  readonly args?: unknown;
}

export interface ActorCallResult<R = unknown> {
  readonly result: R;
}

export interface ActorSubscribeParams {
  readonly class: string;
  readonly id: string;
}

export interface ActorSubscribeResult {
  readonly subscriptionId: string;
}

export interface ActorUnsubscribeParams {
  readonly subscriptionId: string;
}

export interface ActorUnsubscribeResult {
  readonly ok: boolean;
}

/* ----------------------------------------------- actor.event notif */

export type SubscriberKind = 'snapshot' | 'patch' | 'event' | 'tombstone';

export interface ActorEventNotification {
  readonly subscriptionId: string;
  readonly kind: SubscriberKind;
  /** snapshot/SWM: full state. */
  readonly data?: unknown;
  /** patch/SWM: RFC 6902 ops. */
  readonly patch?: readonly unknown[];
  /** event/ES: raw events appended in this commit. */
  readonly events?: readonly unknown[];
  /** ES head seq; "0" for SWM. */
  readonly seq?: string;
}

/* ----------------------------------------------------- Method map */

export interface MethodMap {
  'actor.call': { params: ActorCallParams; result: ActorCallResult };
  'actor.subscribe': { params: ActorSubscribeParams; result: ActorSubscribeResult };
  'actor.unsubscribe': { params: ActorUnsubscribeParams; result: ActorUnsubscribeResult };
}

export interface NotificationMap {
  'actor.event': ActorEventNotification;
}

export type MethodName = keyof MethodMap;
export type NotificationName = keyof NotificationMap;
