/**
 * Idempotency-Key handling.
 *
 * preHandler hook: if the request carries `Idempotency-Key` AND the
 * key already has a stored response, short-circuit by replaying the
 * stored status + body. Echoes the key back in the response header
 * so the SDK can confirm replay.
 *
 * onSend hook: if we didn't replay AND the response is a 2xx for a
 * mutating method (POST / PATCH / DELETE), store the response for
 * 24h.
 *
 * Storage uses the existing `driver.loadIdempotency` /
 * `saveIdempotency` (Phase 2).
 */
import type {
  FastifyReply,
  FastifyRequest,
  onSendAsyncHookHandler,
  preHandlerAsyncHookHandler,
} from 'fastify';

import type { StorageDriver } from '../../storage/driver.js';

const HEADER = 'idempotency-key';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'DELETE', 'PUT']);

declare module 'fastify' {
  interface FastifyRequest {
    idempotencyKey?: string;
    idempotencyReplayed?: boolean;
  }
}

interface StoredResponse {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
}

export interface IdempotencyHookOptions {
  readonly driver: StorageDriver;
  readonly ttlMs?: number;
}

export function makeIdempotencyHooks(options: IdempotencyHookOptions): {
  preHandler: preHandlerAsyncHookHandler;
  onSend: onSendAsyncHookHandler<unknown>;
} {
  const { driver } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

  const preHandler: preHandlerAsyncHookHandler = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const key = req.headers[HEADER];
    if (!key || typeof key !== 'string') return;
    if (!MUTATING_METHODS.has(req.method)) return;
    req.idempotencyKey = key;

    const stored = await driver.loadIdempotency<StoredResponse>(key);
    if (!stored) return;
    req.idempotencyReplayed = true;
    await reply
      .code(stored.response.status)
      .header('content-type', stored.response.contentType)
      .header('Idempotency-Key', key)
      .header('Idempotency-Replayed', 'true')
      .send(stored.response.body);
  };

  const onSend: onSendAsyncHookHandler<unknown> = async (
    req: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
  ): Promise<unknown> => {
    if (req.idempotencyReplayed) return payload;
    const key = req.idempotencyKey;
    if (!key) return payload;
    if (reply.statusCode < 200 || reply.statusCode >= 300) return payload;
    // Fastify reaches `onSend` with the serialized body (string | Buffer)
    // for JSON responses. We store as-is.
    const body =
      typeof payload === 'string'
        ? payload
        : Buffer.isBuffer(payload)
          ? payload.toString('utf8')
          : JSON.stringify(payload);
    const contentType =
      (reply.getHeader('content-type') as string | undefined) ?? 'application/json';
    const record: StoredResponse = {
      status: reply.statusCode,
      body,
      contentType,
    };
    await driver.saveIdempotency(key, record, ttlMs).catch(() => undefined);
    void reply.header('Idempotency-Key', key);
    return payload;
  };

  return { preHandler, onSend };
}
