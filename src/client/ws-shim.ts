/**
 * Minimal structural shim for the WebSocket constructor.
 *
 * The SDK runs in browsers (global `WebSocket`), Node 22+ (also
 * global `WebSocket`), and Node ≤ 21 / tests via the `ws` package.
 * All three expose a close-enough shape; we type the surface we
 * actually use so the SDK is portable without dragging in the
 * DOM lib or coupling to the `ws` npm package's types.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'close', listener: (ev: unknown) => void): void;
  addEventListener(type: 'message', listener: (ev: unknown) => void): void;
  addEventListener(type: 'error', listener: (ev: unknown) => void): void;
}

export type WebSocketCtor = new (
  url: string,
  protocols?: string | readonly string[],
) => WebSocketLike;
