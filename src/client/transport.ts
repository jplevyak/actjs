/**
 * WebSocket transport with reconnect + outbound queue.
 *
 * One socket per Client. While `open`, frames are sent immediately;
 * while `closed`/`connecting`, they're held in an in-memory queue
 * and flushed in order on the next `open`. The transport is
 * intentionally dumb about JSON-RPC semantics — it sends strings,
 * emits incoming strings, and tells the layer above when the
 * connection comes up or goes down.
 *
 * Reconnect uses full-jitter exponential backoff: the next delay is
 * picked uniformly from `[0, min(cap, base * 2^attempt))`. This is
 * the AWS-architecture recommendation; it prevents a thundering
 * herd when many clients reconnect simultaneously.
 */

import type { WebSocketLike, WebSocketCtor } from './ws-shim.js';

export type TransportState = 'idle' | 'connecting' | 'open' | 'closed';

export interface TransportEvents {
  onMessage: (text: string) => void;
  onOpen: () => void;
  onClose: (info: { code: number; reason: string; clean: boolean }) => void;
  /** Fired before any reconnect attempt with the planned delay. */
  onReconnectScheduled?: (delayMs: number, attempt: number) => void;
}

export interface TransportOptions extends TransportEvents {
  readonly url: string;
  /** WebSocket subprotocols (e.g. for auth headers). */
  readonly protocols?: readonly string[];
  /** Test seam: inject a constructor; defaults to global `WebSocket`. */
  readonly wsCtor?: WebSocketCtor;
  /** Disable reconnect entirely (manual retry). */
  readonly autoReconnect?: boolean;
  /** Base backoff in ms; default 250. */
  readonly backoffBaseMs?: number;
  /** Cap on backoff in ms; default 30 000. */
  readonly backoffCapMs?: number;
  /** Override the jitter source for tests. */
  readonly random?: () => number;
}

export class Transport {
  private socket: WebSocketLike | null = null;
  private state: TransportState = 'idle';
  /** Outbound frames held while the socket isn't open. */
  private readonly outbound: string[] = [];
  /** Listeners attached for the lifetime of the transport. */
  private readonly events: TransportEvents;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private readonly url: string;
  private readonly protocols: readonly string[] | undefined;
  private readonly wsCtor: WebSocketCtor;
  private readonly autoReconnect: boolean;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly random: () => number;

  constructor(options: TransportOptions) {
    this.url = options.url;
    this.protocols = options.protocols;
    this.wsCtor = options.wsCtor ?? defaultWsCtor();
    this.autoReconnect = options.autoReconnect ?? true;
    this.backoffBaseMs = options.backoffBaseMs ?? 250;
    this.backoffCapMs = options.backoffCapMs ?? 30_000;
    this.random = options.random ?? Math.random;
    this.events = {
      onMessage: options.onMessage,
      onOpen: options.onOpen,
      onClose: options.onClose,
      ...(options.onReconnectScheduled
        ? { onReconnectScheduled: options.onReconnectScheduled }
        : {}),
    };
  }

  /** Open the socket. Idempotent — calling twice has no effect. */
  connect(): void {
    if (this.destroyed) throw new Error('transport destroyed');
    if (this.state === 'open' || this.state === 'connecting') return;
    this.state = 'connecting';
    const Ctor = this.wsCtor;
    const socket = this.protocols ? new Ctor(this.url, this.protocols) : new Ctor(this.url);
    this.socket = socket;
    socket.addEventListener('open', () => this.handleOpen());
    socket.addEventListener('message', (ev) => {
      const data = (ev as { data?: unknown }).data;
      if (typeof data === 'string') this.events.onMessage(data);
      else if (data instanceof ArrayBuffer) {
        this.events.onMessage(new TextDecoder().decode(data));
      }
    });
    socket.addEventListener('close', (ev) => {
      const e = ev as { code?: number; reason?: string; wasClean?: boolean };
      this.handleClose({
        code: e.code ?? 1006,
        reason: e.reason ?? '',
        clean: e.wasClean ?? false,
      });
    });
    socket.addEventListener('error', () => {
      // Most browsers fire `close` after `error`; nothing to do here.
    });
  }

  /** Send a string frame. Queues if not currently open. */
  send(frame: string): void {
    if (this.state === 'open' && this.socket) {
      this.socket.send(frame);
      return;
    }
    this.outbound.push(frame);
    if (this.state === 'idle' || this.state === 'closed') {
      // Either we've never connected or we're in the reconnect
      // grace period — kick the connection.
      this.connect();
    }
  }

  /** Close gracefully and tear down listeners. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close(1000, 'client closed');
      } catch {
        // ignore
      }
    }
    this.outbound.length = 0;
    this.state = 'closed';
  }

  getState(): TransportState {
    return this.state;
  }

  /** Test seam: pending outbound frames. */
  pendingFrames(): readonly string[] {
    return [...this.outbound];
  }

  private handleOpen(): void {
    this.state = 'open';
    this.reconnectAttempts = 0;
    // Drain queue in order before notifying the layer above so the
    // first send-after-open synchronously rides the same socket.
    const drained = this.outbound.splice(0, this.outbound.length);
    for (const frame of drained) {
      try {
        this.socket!.send(frame);
      } catch {
        // Best-effort: re-queue for the next reconnect.
        this.outbound.unshift(frame);
        break;
      }
    }
    this.events.onOpen();
  }

  private handleClose(info: { code: number; reason: string; clean: boolean }): void {
    const wasOpen = this.state === 'open' || this.state === 'connecting';
    this.state = 'closed';
    this.socket = null;
    if (wasOpen) this.events.onClose(info);
    if (!this.destroyed && this.autoReconnect && info.code !== 1000) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    const attempt = this.reconnectAttempts++;
    const ceil = Math.min(this.backoffCapMs, this.backoffBaseMs * 2 ** attempt);
    const delay = Math.floor(this.random() * ceil);
    this.events.onReconnectScheduled?.(delay, attempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.destroyed) return;
      this.connect();
    }, delay);
    if (
      this.reconnectTimer &&
      typeof (this.reconnectTimer as { unref?: () => void }).unref === 'function'
    ) {
      (this.reconnectTimer as { unref: () => void }).unref();
    }
  }
}

function defaultWsCtor(): WebSocketCtor {
  const g = globalThis as { WebSocket?: WebSocketCtor };
  if (!g.WebSocket) {
    throw new Error(
      'no global WebSocket constructor available — pass `wsCtor` (e.g. the `ws` package) explicitly',
    );
  }
  return g.WebSocket;
}
