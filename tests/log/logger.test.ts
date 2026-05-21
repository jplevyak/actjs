import pino from 'pino';
import { describe, expect, it } from 'vitest';

import {
  makeCollectingLogger,
  makeLogger,
  makeNoopLogger,
  type CollectedEvent,
} from '../../src/log/index.js';

describe('Logger', () => {
  it('noop logger drops everything', () => {
    const log = makeNoopLogger();
    log.info('hello', { actorId: 'x' });
    expect(log.level).toBe('silent');
  });

  it('collecting logger captures fields + message', () => {
    const events: CollectedEvent[] = [];
    const log = makeCollectingLogger(events, { subsystem: 'runtime' });
    log.info('hello', { actorId: 'a' });
    expect(events).toEqual([
      { level: 'info', msg: 'hello', fields: { subsystem: 'runtime', actorId: 'a' } },
    ]);
  });

  it('collecting child merges fields onto every event', () => {
    const events: CollectedEvent[] = [];
    const log = makeCollectingLogger(events).child({ requestId: 'r1' });
    log.warn('w', { actorId: 'a' });
    expect(events[0]?.fields).toEqual({ requestId: 'r1', actorId: 'a' });
  });

  it('pino-backed logger emits one JSON line per event', () => {
    const chunks: string[] = [];
    const stream = { write: (line: string) => chunks.push(line) };
    const p = pino({ level: 'info' }, stream as never);
    const log = makeLogger({ pino: p });
    log.info('hello world', { requestId: 'abc' });
    expect(chunks).toHaveLength(1);
    const parsed = JSON.parse(chunks[0]!) as { msg: string; requestId: string };
    expect(parsed.msg).toBe('hello world');
    expect(parsed.requestId).toBe('abc');
  });

  it('redacts authorization headers', () => {
    const chunks: string[] = [];
    const stream = { write: (line: string) => chunks.push(line) };
    const p = pino(
      {
        level: 'info',
        redact: {
          paths: ['req.headers.authorization', '*.authorization'],
          censor: '[redacted]',
        },
      },
      stream as never,
    );
    const log = makeLogger({ pino: p });
    log.info('req', {
      req: { headers: { authorization: 'Bearer secret' } },
    });
    const parsed = JSON.parse(chunks[0]!) as {
      req: { headers: { authorization: string } };
    };
    expect(parsed.req.headers.authorization).toBe('[redacted]');
  });
});
