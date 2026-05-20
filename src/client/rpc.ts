/**
 * JSON-RPC 2.0 client over a {@link Transport}.
 *
 * Owns:
 *   - pending request map keyed by JSON-RPC id;
 *   - notification dispatch table keyed by method name;
 *   - request id allocation;
 *   - reconnect bookkeeping: on each reconnect, pending requests
 *     are reissued (the server is at-least-once for `actor.call`
 *     when the client supplies an `Idempotency-Key`).
 *
 * The transport is JSON-text-in/JSON-text-out; this layer turns
 * envelopes into promises and notifications into typed events.
 */
import {
  ACTJS_FRAMEWORK_ERROR,
  JSON_RPC_INTERNAL_ERROR,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccess,
  type MethodMap,
  type MethodName,
  type NotificationMap,
  type NotificationName,
} from '../wire/index.js';

import type { Transport } from './transport.js';

export type NotificationListener<N extends NotificationName> = (params: NotificationMap[N]) => void;

export interface RpcClientOptions {
  /** Override id allocation for tests / deterministic logs. */
  readonly nextId?: () => JsonRpcId;
}

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  /** Convenience: actjs framework errors carry a `code` string in `data`. */
  readonly frameworkCode?: string;
  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
    if (data && typeof data === 'object' && typeof (data as { code?: unknown }).code === 'string') {
      this.frameworkCode = (data as { code: string }).code;
    }
  }
}

interface Pending {
  resolve: (r: unknown) => void;
  reject: (err: unknown) => void;
  /** Original frame; reissued on reconnect when the call is in flight. */
  readonly frame: string;
}

export class RpcClient {
  private nextSequenceId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly listeners = new Map<string, Set<(p: unknown) => void>>();
  private readonly nextId: () => JsonRpcId;
  /** Calls registered as "reissue on reconnect" — set by `request`. */
  private isOpen = false;

  constructor(
    private readonly transport: Transport,
    options: RpcClientOptions = {},
  ) {
    this.nextId = options.nextId ?? (() => this.nextSequenceId++);
  }

  /** Mark the connection open (called by Client). Reissues pending. */
  handleOpen(): void {
    this.isOpen = true;
    // Re-send every in-flight request. The server is idempotent on
    // `actor.subscribe` (it returns a fresh subscriptionId per call;
    // we drop the old subscription server-side via close-of-connection
    // semantics) and on `actor.call` when an Idempotency-Key is set.
    for (const p of this.pending.values()) {
      this.transport.send(p.frame);
    }
  }

  /** Mark the connection closed. Pending calls remain queued. */
  handleClose(): void {
    this.isOpen = false;
  }

  /** Notify-only — no `id`, no response expected. */
  notify(method: string, params: unknown): void {
    const frame: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.transport.send(JSON.stringify(frame));
  }

  /**
   * Issue a request. Resolves with the JSON-RPC `result`, rejects
   * with {@link RpcError} on `{error: ...}` or transport teardown.
   * The transport queues the frame if the socket isn't open.
   */
  request<M extends MethodName>(
    method: M,
    params: MethodMap[M]['params'],
  ): Promise<MethodMap[M]['result']>;
  request(method: string, params: unknown): Promise<unknown>;
  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId();
    const frame: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const serialized = JSON.stringify(frame);
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, frame: serialized });
      this.transport.send(serialized);
    });
  }

  /**
   * Process one incoming frame from the transport. Public so the
   * Client can dispatch raw messages.
   */
  ingest(text: string): void {
    let msg: JsonRpcResponse | JsonRpcNotification;
    try {
      msg = JSON.parse(text) as JsonRpcResponse | JsonRpcNotification;
    } catch {
      // Malformed frame — nothing actionable here; tests can hook
      // `transport.onMessage` if they need to surface it.
      return;
    }
    if (isResponse(msg)) {
      const id = (msg as JsonRpcSuccess | JsonRpcError).id;
      if (id === null || id === undefined) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if ('error' in msg) {
        const err = msg.error;
        pending.reject(new RpcError(err.message, err.code, err.data));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (isNotification(msg)) {
      const set = this.listeners.get(msg.method);
      if (set) {
        for (const fn of set) fn(msg.params);
      }
    }
  }

  /** Subscribe to a notification kind. Returns an unsubscribe fn. */
  on<N extends NotificationName>(method: N, fn: NotificationListener<N>): () => void;
  on(method: string, fn: (params: unknown) => void): () => void;
  on(method: string, fn: (params: unknown) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(method);
    };
  }

  /** Reject every pending call with the supplied error. Used on destroy. */
  rejectAll(err: unknown): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /** Test seam. */
  pendingCount(): number {
    return this.pending.size;
  }

  /** Test seam — current socket-open state. */
  open(): boolean {
    return this.isOpen;
  }
}

function isResponse(msg: unknown): msg is JsonRpcResponse {
  return !!msg && typeof msg === 'object' && 'id' in msg && ('result' in msg || 'error' in msg);
}

function isNotification(msg: unknown): msg is JsonRpcNotification {
  return !!msg && typeof msg === 'object' && 'method' in msg && !('id' in msg);
}

/** Re-export common error code constants for SDK consumers. */
export { ACTJS_FRAMEWORK_ERROR, JSON_RPC_INTERNAL_ERROR };
