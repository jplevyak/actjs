/**
 * WebSocket endpoint mounted at `/v1/ws`.
 *
 * JSON-RPC 2.0 framing. Methods:
 *   - actor.call(class, id, method, args)         → {result, seq?}
 *   - actor.subscribe(class, id)                  → {subscriptionId}
 *   - actor.unsubscribe(subscriptionId)           → {ok: true}
 *
 * Notifications (server → client):
 *   - actor.event {subscriptionId, kind, data?, patch?, events?, seq?}
 *
 * Heartbeat: server pings every `pingIntervalMs`; if no pong arrives
 * within `pingTimeoutMs`, the connection is closed.
 */
import type { FastifyInstance } from 'fastify';

import type { Runtime } from '../../runtime/index.js';
import type { ActorId, ClassName } from '../../types/ids.js';
import { asActorId, asClassName } from '../../types/index.js';
import {
  SubscriberLimitError,
  SubscriptionRegistry,
  type SubscriberNotification,
} from '../subscription-registry.js';

const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_PING_TIMEOUT_MS = 90_000;

export interface WsRouteOptions {
  readonly runtime: Runtime;
  readonly registry: SubscriptionRegistry;
  readonly pingIntervalMs?: number;
  readonly pingTimeoutMs?: number;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number | string;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: unknown;
}

// Standard JSON-RPC error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
// Framework error band.
const FRAMEWORK_ERROR = -32000;

interface ActorCallParams {
  class: string;
  id: string;
  method: string;
  args?: unknown;
}
interface ActorSubscribeParams {
  class: string;
  id: string;
}
interface ActorUnsubscribeParams {
  subscriptionId: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function validateActorCallParams(p: unknown): ActorCallParams | string {
  if (!isObject(p)) return 'expected object params';
  if (typeof p['class'] !== 'string') return 'missing string `class`';
  if (typeof p['id'] !== 'string') return 'missing string `id`';
  if (typeof p['method'] !== 'string') return 'missing string `method`';
  return {
    class: p['class'],
    id: p['id'],
    method: p['method'],
    args: p['args'] ?? {},
  };
}

function validateActorSubscribeParams(p: unknown): ActorSubscribeParams | string {
  if (!isObject(p)) return 'expected object params';
  if (typeof p['class'] !== 'string') return 'missing string `class`';
  if (typeof p['id'] !== 'string') return 'missing string `id`';
  return { class: p['class'], id: p['id'] };
}

function validateActorUnsubscribeParams(p: unknown): ActorUnsubscribeParams | string {
  if (!isObject(p)) return 'expected object params';
  if (typeof p['subscriptionId'] !== 'string') return 'missing string `subscriptionId`';
  return { subscriptionId: p['subscriptionId'] };
}

export async function registerWsRoute(
  app: FastifyInstance,
  options: WsRouteOptions,
): Promise<void> {
  const { runtime, registry } = options;
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;

  // The Fastify `websocket: true` route option flips the handler into
  // WS mode; `socket` is a ws WebSocket. The auth preHandler has
  // already populated `req.principal`; we capture it for the lifetime
  // of the connection so every actor.call carries the right caller.
  app.get('/v1/ws', { websocket: true }, (socket /*: WebSocket */, req): void => {
    const principal = req.principal;
    let lastPongAt = Date.now();
    const heartbeat = setInterval(() => {
      try {
        socket.ping();
      } catch {
        // ignore — close handler will fire
      }
      if (Date.now() - lastPongAt > pingTimeoutMs) {
        try {
          socket.close(1001, 'heartbeat timeout');
        } catch {
          // ignore
        }
      }
    }, pingIntervalMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    socket.on('pong', () => {
      lastPongAt = Date.now();
    });

    const send = (msg: JsonRpcSuccess | JsonRpcError | JsonRpcNotification): void => {
      if (socket.readyState !== 1 /* OPEN */) return;
      socket.send(JSON.stringify(msg));
    };

    const sendError = (
      id: number | string | null,
      code: number,
      message: string,
      data?: unknown,
    ): void => {
      const err: JsonRpcError = {
        jsonrpc: '2.0',
        id,
        error: data !== undefined ? { code, message, data } : { code, message },
      };
      send(err);
    };

    const subscriberSink = (notification: SubscriberNotification): void => {
      send({
        jsonrpc: '2.0',
        method: 'actor.event',
        params: notification,
      });
    };

    socket.on('message', (raw: Buffer | string) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(text) as JsonRpcRequest;
      } catch {
        sendError(null, PARSE_ERROR, 'parse error');
        return;
      }
      if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
        sendError(req.id ?? null, INVALID_REQUEST, 'invalid jsonrpc envelope');
        return;
      }
      // Run async; capture id for error replies.
      void dispatch(req).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        sendError(req.id ?? null, INTERNAL_ERROR, message);
      });
    });

    socket.on('close', () => {
      clearInterval(heartbeat);
      registry.unsubscribeConnection(socket);
    });

    async function dispatch(req: JsonRpcRequest): Promise<void> {
      const id = req.id;
      switch (req.method) {
        case 'actor.call': {
          const p = validateActorCallParams(req.params);
          if (typeof p === 'string') {
            if (id !== undefined) sendError(id, INVALID_PARAMS, p);
            return;
          }
          try {
            const result = await runtime.call(
              asClassName(p.class) as ClassName,
              asActorId(p.id) as ActorId,
              p.method,
              p.args,
              principal,
            );
            if (id !== undefined) {
              send({ jsonrpc: '2.0', id, result: { result } });
            }
          } catch (err) {
            if (id !== undefined) {
              const message = err instanceof Error ? err.message : String(err);
              const code =
                err instanceof Error &&
                'code' in err &&
                typeof (err as { code: unknown }).code === 'string'
                  ? FRAMEWORK_ERROR
                  : INTERNAL_ERROR;
              sendError(id, code, message, {
                code: (err as { code?: string }).code ?? err?.constructor?.name,
              });
            }
          }
          return;
        }

        case 'actor.subscribe': {
          const p = validateActorSubscribeParams(req.params);
          if (typeof p === 'string') {
            if (id !== undefined) sendError(id, INVALID_PARAMS, p);
            return;
          }
          try {
            const sub = await registry.subscribe(
              socket,
              asClassName(p.class) as ClassName,
              asActorId(p.id) as ActorId,
              subscriberSink,
            );
            if (id !== undefined) {
              send({ jsonrpc: '2.0', id, result: sub });
            }
          } catch (err) {
            if (id !== undefined) {
              const message = err instanceof Error ? err.message : String(err);
              if (err instanceof SubscriberLimitError) {
                sendError(id, FRAMEWORK_ERROR, message, { code: 'SubscriberLimit' });
              } else {
                sendError(id, INTERNAL_ERROR, message);
              }
            }
          }
          return;
        }

        case 'actor.unsubscribe': {
          const p = validateActorUnsubscribeParams(req.params);
          if (typeof p === 'string') {
            if (id !== undefined) sendError(id, INVALID_PARAMS, p);
            return;
          }
          const ok = registry.unsubscribe(p.subscriptionId);
          if (id !== undefined) {
            send({ jsonrpc: '2.0', id, result: { ok } });
          }
          return;
        }

        default:
          if (id !== undefined) {
            sendError(id, METHOD_NOT_FOUND, `unknown method: ${req.method}`);
          }
      }
    }
  });
}
