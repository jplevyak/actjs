/**
 * SSE fallback endpoint mounted at
 *   GET /v1/actors/:class/:id/events
 *
 * Streams the same shape of notifications the WS endpoint emits
 * (`snapshot` / `patch` / `event` / `tombstone`) using the
 * SubscriptionRegistry. Wire format is the standard `text/event-stream`:
 *
 *   id: <subscriptionId>:<seqOrCounter>
 *   event: actor.event
 *   data: { ... json ... }
 *
 * Keep-alive comments (`:keepalive\n\n`) are emitted every `keepAliveMs`
 * to keep proxies from collapsing the connection.
 *
 * `Last-Event-ID` (header) lets a reconnecting client request events
 * with `seq > N`. For ES actors this is replayed exactly from the
 * event log. For SWM actors the post-snapshot stream resumes from
 * the live commit listener — patches that happened during the
 * client's disconnect are lost (SWM has no log to replay from), so
 * the resumed stream begins with a fresh snapshot.
 *
 * Manifest pin: the standard `X-Actjs-Manifest` header is preferred;
 * a `?manifest=<sha>` query param is also accepted because browsers
 * can't set arbitrary headers on `EventSource`.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Runtime } from '../../runtime/index.js';
import type { StorageDriver } from '../../storage/driver.js';
import type { ActorId, ClassName } from '../../types/ids.js';
import { asActorId, asClassName } from '../../types/index.js';
import type { TypedFastifyInstance } from '../app.js';
import type {
  SubscriberNotification,
  SubscriberSink,
  SubscriptionRegistry,
} from '../subscription-registry.js';

const DEFAULT_KEEPALIVE_MS = 25_000;

export interface SseRouteOptions {
  readonly runtime: Runtime;
  readonly driver: StorageDriver;
  readonly registry: SubscriptionRegistry;
  readonly keepAliveMs?: number;
}

const ActorParam = z.object({
  class: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'invalid class name'),
  id: z.string().min(1),
});

export function registerSseRoute(app: TypedFastifyInstance, options: SseRouteOptions): void {
  const { runtime, driver, registry } = options;
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEPALIVE_MS;

  app.get(
    '/v1/actors/:class/:id/events',
    {
      schema: {
        summary: 'Server-Sent Events stream of actor commits',
        tags: ['actors'],
        params: ActorParam,
        // Skipping a response schema: SSE is a raw stream and the
        // Zod serializer would try to JSON-encode the reply body.
      },
    },
    async (req, reply) => {
      const className = asClassName(req.params.class);
      const id = asActorId(req.params.id);

      // The pin preHandler validated the manifest already; nothing
      // extra to do here. `req.principal` populated by auth hook.

      writeSseHead(reply);
      // Connection keepalive ping. Comment lines (`:`) are ignored by
      // EventSource but flush through proxies.
      const keepAlive = setInterval(() => {
        try {
          reply.raw.write(':keepalive\n\n');
        } catch {
          // socket closed; cleanup runs in the close handler
        }
      }, keepAliveMs);
      if (typeof keepAlive.unref === 'function') keepAlive.unref();

      // Each notification gets a synthetic event id so the client
      // can pick the resume point. For ES we use the `seq`; for SWM
      // we use a per-connection counter.
      let counter = 0;
      const sink: SubscriberSink = (notification) => {
        counter++;
        const eventId = composeEventId(notification, counter);
        const payload = JSON.stringify(stripSubscriptionId(notification));
        try {
          reply.raw.write(`id: ${eventId}\n`);
          reply.raw.write(`event: actor.event\n`);
          reply.raw.write(`data: ${payload}\n\n`);
        } catch {
          // socket closed
        }
      };

      let subscriptionId: string | null = null;
      const cleanup = (): void => {
        clearInterval(keepAlive);
        if (subscriptionId) registry.unsubscribe(subscriptionId);
      };
      req.raw.on('close', cleanup);
      reply.raw.on('close', cleanup);

      // Replay first (if Last-Event-ID supplied + ES actor); then
      // attach the live subscription so the registry's snapshot
      // delivery picks up where we left off.
      const lastEventId = readLastEventId(req);
      let replayedSeq: bigint | null = null;
      if (lastEventId !== null) {
        replayedSeq = await replayFromSeq(driver, runtime, className, id, lastEventId, sink);
      }

      try {
        const sub = await registry.subscribe(
          { raw: reply.raw, isSse: true } as object,
          className as ClassName,
          id as ActorId,
          replayedSeq !== null ? wrapSinkForResume(sink, replayedSeq) : sink,
        );
        subscriptionId = sub.subscriptionId;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          reply.raw.write(`event: error\n`);
          reply.raw.write(`data: ${JSON.stringify({ message })}\n\n`);
          reply.raw.end();
        } catch {
          // ignore
        }
        cleanup();
        return reply;
      }

      // Tell Fastify we've taken over the response stream. The hijack
      // contract: no further reply.send / setHeaders calls, no body
      // serialization. Caller of the handler must not await any other
      // reply API past this point.
      reply.hijack();
      return reply;
    },
  );
}

function writeSseHead(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx-flavored proxy hint: don't buffer this stream.
    'X-Accel-Buffering': 'no',
  });
  // First payload so the browser's `onopen` fires and any keep-alive
  // sweep timer starts ticking.
  reply.raw.write(':open\n\n');
}

function composeEventId(notif: SubscriberNotification, counter: number): string {
  if (notif.seq !== undefined && notif.seq !== '0') return notif.seq;
  return `c${counter}`;
}

function stripSubscriptionId(
  notif: SubscriberNotification,
): Omit<SubscriberNotification, 'subscriptionId'> {
  const { subscriptionId: _drop, ...rest } = notif;
  void _drop;
  return rest;
}

function readLastEventId(req: FastifyRequest): bigint | null {
  const raw = req.headers['last-event-id'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

/**
 * Replay events from the durable log strictly after `fromSeq` for ES
 * actors. SWM actors have no log, so the function is a no-op and
 * returns null — the live subscription will deliver a fresh snapshot.
 *
 * Returns the highest seq replayed (or null if nothing was emitted),
 * so the live wrapper can drop duplicates the registry would also
 * deliver in its first commit notification.
 */
async function replayFromSeq(
  driver: StorageDriver,
  runtime: Runtime,
  className: ClassName,
  id: ActorId,
  fromSeq: bigint,
  sink: SubscriberSink,
): Promise<bigint | null> {
  // Materialize so we can ask the host whether it's ES. SWM actors
  // have nothing to replay; their seq is always 0.
  const host = await runtime.getHost(className, id);
  const head = host.currentEventSeq();
  if (head <= fromSeq) return null;

  const batch: unknown[] = [];
  let lastSeq = fromSeq;
  for await (const record of driver.readEvents(id, fromSeq + 1n)) {
    batch.push(record.payload);
    lastSeq = record.seq;
  }
  if (batch.length === 0) return null;
  sink({
    subscriptionId: 'replay',
    kind: 'event',
    events: batch,
    seq: lastSeq.toString(),
  });
  return lastSeq;
}

function wrapSinkForResume(downstream: SubscriberSink, replayedSeq: bigint): SubscriberSink {
  // Drop the initial `snapshot` (we already replayed past it) and any
  // `event` whose seq is <= replayedSeq (already delivered).
  let droppedSnapshot = false;
  return (notif) => {
    if (!droppedSnapshot && notif.kind === 'snapshot') {
      droppedSnapshot = true;
      return;
    }
    droppedSnapshot = true;
    if (notif.kind === 'event' && notif.seq !== undefined) {
      try {
        if (BigInt(notif.seq) <= replayedSeq) return;
      } catch {
        // fall through
      }
    }
    downstream(notif);
  };
}
