/**
 * Legacy routes ported to Fastify:
 *   GET    /         — health
 *   POST   /run      — execute a JS snippet against a fresh GAct
 *   POST   /upload   — store one or more files as Redis keys
 *
 * These remain available so the existing `demo.bash` flow keeps
 * working until the Phase 1 legacy shim sunsets. The behavior is
 * identical to the Express version; only the framework changed.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createClient, type RedisClientType } from 'redis';

import { StatusError } from '../../error.js';
import GAct, { type RedisLike } from '../../gact.js';
import { adminOnly } from '../admin.js';

type AsyncFn = (gact: GAct) => Promise<unknown>;
const AsyncFunctionCtor = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => AsyncFn;

let nextTransactionId = 1;

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function withRedisClient<T>(
  redisUrl: string | undefined,
  fn: (client: RedisClientType) => Promise<T>,
): Promise<T> {
  const client = (redisUrl ? createClient({ url: redisUrl }) : createClient()) as RedisClientType;
  client.on('error', (err: unknown) => {
    console.error('legacy redis error:', err);
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.quit().catch(() => undefined);
  }
}

export interface LegacyOptions {
  readonly redisUrl?: string;
}

export async function registerLegacyRoutes(
  app: FastifyInstance,
  options: LegacyOptions = {},
): Promise<void> {
  app.get('/', async () => 'Online');

  // /run accepts text/plain (raw code) OR application/json ({ code: "..." })
  // OR any other content type (treated as raw text). We register a custom
  // body parser for `*` content types so anything not JSON lands as a string.
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/run', { preHandler: adminOnly }, async (req: FastifyRequest, reply: FastifyReply) => {
    const code = extractCode(req.body, req.headers['content-type']);
    if (!code) throw new StatusError('missing code in request body', 400);

    let f: AsyncFn;
    try {
      f = new AsyncFunctionCtor('gact', code);
    } catch (e) {
      throw new StatusError(`unable to compile code: ${errMessage(e)}`, 400);
    }

    const result = await withRedisClient(options.redisUrl, async (client) => {
      let attempts = 0;
      for (;;) {
        const tid = nextTransactionId++;
        const gact = new GAct(tid, client as unknown as RedisLike);
        let value: unknown;
        try {
          value = await f(gact);
        } catch (err) {
          if (err instanceof StatusError) throw err;
          throw new StatusError(`script error: ${errMessage(err)}`, 400);
        }
        const committed = await gact.commit();
        if (committed) return value;
        attempts++;
        if (attempts >= gact.max_retries) {
          throw new StatusError('commit conflict: too many retries', 409);
        }
      }
    });

    await reply
      .code(200)
      .type('application/json')
      .send(JSON.stringify(result ?? {}));
  });

  app.post(
    '/upload',
    { preHandler: adminOnly },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.isMultipart()) {
        throw new StatusError('multipart/form-data required', 400);
      }
      const files: { name: string; data: Buffer }[] = [];
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          files.push({ name: part.filename, data: await part.toBuffer() });
        }
      }
      if (files.length === 0) throw new StatusError('no files uploaded', 400);

      const result = await withRedisClient(options.redisUrl, async (client) => {
        const multi = client.multi();
        for (const f of files) {
          multi.set(f.name, f.data.toString('utf8'));
        }
        const r = await multi.exec();
        if (!r) throw new StatusError('upload commit error', 409);
        return r;
      });
      await reply.code(200).send(result);
    },
  );
}

function extractCode(body: unknown, contentType: string | undefined): string | null {
  if (typeof body === 'string') {
    if (contentType?.startsWith('application/json')) {
      try {
        const parsed = JSON.parse(body) as { code?: unknown };
        if (typeof parsed.code === 'string') return parsed.code;
      } catch {
        // fall through — treat as raw text
      }
    }
    return body;
  }
  if (body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string') {
    return (body as { code: string }).code;
  }
  return null;
}
