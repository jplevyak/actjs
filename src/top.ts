import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import multer from 'multer';
import { createClient, type RedisClientType } from 'redis';

import { StatusError } from './error.js';
import GAct, { type RedisLike } from './gact.js';
import { ValkeyPgStorageDriver } from './storage/valkey-pg.js';
import { registerV1Routes } from './v1/routes.js';

type AsyncFn = (gact: GAct) => Promise<unknown>;
const AsyncFunctionCtor = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => AsyncFn;

const PORT = Number(process.argv[2] ?? process.env['PORT'] ?? 3000);
const REDIS_URL = process.env['REDIS_URL'];
const POSTGRES_URL = process.env['DATABASE_URL'] ?? process.env['POSTGRES_URL'];

let nextTransactionId = 1;

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Phase 4.1+ versioned API needs a long-lived storage driver. It's wired
// only when POSTGRES_URL is set; in legacy-sketch mode the /v1 routes are
// absent and the existing /run + /upload remain the only surface.
let v1Driver: ValkeyPgStorageDriver | null = null;
if (POSTGRES_URL) {
  v1Driver = new ValkeyPgStorageDriver({
    postgresUrl: POSTGRES_URL,
    ...(REDIS_URL ? { redisUrl: REDIS_URL } : {}),
  });
  await v1Driver.init();
  registerV1Routes(app, v1Driver);
}

app.get('/', (_req: Request, res: Response) => {
  res.status(200).send('Online');
});

// JSON bodies parse as objects; anything else is treated as a raw text body
// so /run can be POSTed with any (or no) Content-Type. These are scoped to /run
// so they do not consume the multipart body destined for multer on /upload.
const runBodyParsers: RequestHandler[] = [express.json(), express.text({ type: '*/*' })];

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function withRedisClient<T>(fn: (client: RedisClientType) => Promise<T>): Promise<T> {
  const client = (REDIS_URL ? createClient({ url: REDIS_URL }) : createClient()) as RedisClientType;
  client.on('error', (err: unknown) => {
    console.error('redis client error:', err);
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.quit().catch(() => undefined);
  }
}

app.post('/upload', upload.any(), async (req: Request, res: Response) => {
  const files = (req.files ?? []) as Express.Multer.File[];
  if (files.length === 0) throw new StatusError('no files uploaded', 400);
  const result = await withRedisClient(async (client) => {
    const multi = client.multi();
    for (const file of files) {
      multi.set(file.originalname, file.buffer.toString('utf8'));
    }
    const r = await multi.exec();
    if (!r) throw new StatusError('upload commit error', 409);
    return r;
  });
  res.status(200).json(result);
});

function extractCode(req: Request): string | null {
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof (req.body as { code?: unknown }).code === 'string') {
    return (req.body as { code: string }).code;
  }
  return null;
}

app.post('/run', runBodyParsers, async (req: Request, res: Response) => {
  const code = extractCode(req);
  if (!code) throw new StatusError('missing code in request body', 400);

  let f: AsyncFn;
  try {
    f = new AsyncFunctionCtor('gact', code);
  } catch (e) {
    throw new StatusError(`unable to compile code: ${errMessage(e)}`, 400);
  }

  const result = await withRedisClient(async (client) => {
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

  res.status(200).json(result ?? {});
});

const errorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  if (err instanceof StatusError) {
    res.status(err.status).json({
      name: err.name,
      message: err.message,
    });
    return;
  }
  console.error('unhandled error:', err);
  res.status(500).json({ name: 'InternalError', message: errMessage(err) });
};
app.use(errorHandler);

const server = app.listen(PORT, () => {
  console.info(`actjs listening on port ${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.info(`received ${sig}, shutting down`);
    server.close(() => {
      if (v1Driver) void v1Driver.close();
      process.exit(0);
    });
  });
}
