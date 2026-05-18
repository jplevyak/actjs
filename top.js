import express from 'express';
import multer from 'multer';
import { createClient } from 'redis';

import GAct from './gact.js';
import { StatusError } from './error.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 3000);
const REDIS_URL = process.env.REDIS_URL;

let nextTransactionId = 1;

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.get('/', (_req, res) => {
  res.status(200).send('Online');
});

// JSON bodies parse as objects; anything else is treated as a raw text body
// so /run can be POSTed with any (or no) Content-Type. These are scoped to /run
// so they do not consume the multipart body destined for multer on /upload.
const runBodyParsers = [express.json(), express.text({ type: '*/*' })];

async function withRedisClient(fn) {
  const client = createClient(REDIS_URL ? { url: REDIS_URL } : undefined);
  client.on('error', (err) => {
    console.error('redis client error:', err);
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.quit().catch(() => {});
  }
}

app.post('/upload', upload.any(), async (req, res) => {
  if (!req.files?.length) throw new StatusError('no files uploaded', 400);
  const result = await withRedisClient(async (client) => {
    const multi = client.multi();
    for (const file of req.files) {
      multi.set(file.originalname, file.buffer.toString('utf8'));
    }
    const r = await multi.exec();
    if (!r) throw new StatusError('upload commit error', 409);
    return r;
  });
  res.status(200).json(result);
});

function extractCode(req) {
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body.code === 'string') return req.body.code;
  return null;
}

app.post('/run', runBodyParsers, async (req, res) => {
  const code = extractCode(req);
  if (!code) throw new StatusError('missing code in request body', 400);

  let f;
  try {
    f = new AsyncFunction('gact', code);
  } catch (e) {
    throw new StatusError(`unable to compile code: ${e.message}`, 400);
  }

  const result = await withRedisClient(async (client) => {
    let attempts = 0;
    for (;;) {
      const tid = nextTransactionId++;
      const gact = new GAct(tid, client);
      let value;
      try {
        value = await f(gact);
      } catch (err) {
        if (err instanceof StatusError) throw err;
        throw new StatusError(`script error: ${err.message}`, 400);
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

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof StatusError || err?.name === 'StatusError') {
    res.status(err.status ?? 500).json({
      name: err.name,
      message: err.message,
    });
    return;
  }
  console.error('unhandled error:', err);
  res.status(500).json({ name: 'InternalError', message: err.message ?? String(err) });
});

const server = app.listen(PORT, () => {
  console.log(`actjs listening on port ${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`received ${sig}, shutting down`);
    server.close(() => process.exit(0));
  });
}
