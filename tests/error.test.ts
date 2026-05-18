import { describe, expect, it } from 'vitest';

import { StatusError } from '../src/error.js';

describe('StatusError', () => {
  it('is an Error subclass', () => {
    const e = new StatusError('boom', 400);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(StatusError);
  });

  it('preserves message and status', () => {
    const e = new StatusError('boom', 418);
    expect(e.message).toBe('boom');
    expect(e.status).toBe(418);
    expect(e.name).toBe('StatusError');
  });

  it('defaults status to 500', () => {
    const e = new StatusError('boom');
    expect(e.status).toBe(500);
  });

  it('captures a stack', () => {
    const e = new StatusError('boom');
    expect(typeof e.stack).toBe('string');
  });
});
