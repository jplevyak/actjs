/**
 * Unit tests for the `Auditor` wrapper.
 *
 * Covers: id/ts auto-fill, principal derivation (string + Principal +
 * system), strict-mode failure propagates, best-effort swallows.
 */
import { describe, expect, it, vi } from 'vitest';

import { Auditor, AuditWriteError } from '../../src/audit/index.js';
import { systemPrincipal } from '../../src/types/principal.js';

interface FakeDriver {
  appendAudit: (entry: unknown) => Promise<void>;
}

function fakeDriver(): FakeDriver & { entries: unknown[] } {
  const entries: unknown[] = [];
  return {
    entries,
    async appendAudit(entry) {
      entries.push(entry);
    },
  };
}

describe('Auditor', () => {
  it('records an entry with auto-generated id and ts', async () => {
    const drv = fakeDriver();
    const auditor = new Auditor(drv as unknown as never, {
      nowMs: () => 1000,
      nextId: () => 'fixed-id',
    });
    await auditor.record({
      action: 'class.published',
      target: 'Note@1.0.0',
      principal: 'admin',
      meta: { sha256: 'abc' },
    });
    expect(drv.entries).toEqual([
      {
        id: 'fixed-id',
        ts: 1000,
        principal: 'admin',
        action: 'class.published',
        target: 'Note@1.0.0',
        meta: { sha256: 'abc' },
      },
    ]);
  });

  it('derives the principal subject from a Principal object', async () => {
    const drv = fakeDriver();
    const auditor = new Auditor(drv as unknown as never);
    await auditor.record({
      action: 'class.published',
      target: 'Note@1.0.0',
      principal: { sub: 'user-123', roles: ['admin'] },
    });
    expect((drv.entries[0] as { principal: string }).principal).toBe('user-123');
  });

  it('maps the system principal to "system"', async () => {
    const drv = fakeDriver();
    const auditor = new Auditor(drv as unknown as never);
    await auditor.record({
      action: 'actor.migrated',
      target: 'Counter:abc',
      principal: systemPrincipal(),
    });
    expect((drv.entries[0] as { principal: string }).principal).toBe('system');
  });

  it('defaults to anonymous when no principal is supplied', async () => {
    const drv = fakeDriver();
    const auditor = new Auditor(drv as unknown as never);
    await auditor.record({ action: 'capability.minted', target: 'Note:x' });
    expect((drv.entries[0] as { principal: string }).principal).toBe('anonymous');
  });

  it('strict mode: a failing appendAudit propagates AuditWriteError', async () => {
    const drv = {
      appendAudit: vi.fn().mockRejectedValue(new Error('disk full')),
    };
    const auditor = new Auditor(drv as unknown as never, { mode: 'strict' });
    await expect(
      auditor.record({ action: 'class.published', target: 'X@1.0.0' }),
    ).rejects.toBeInstanceOf(AuditWriteError);
  });

  it('best-effort mode: a failure is reported to onError but not thrown', async () => {
    const drv = {
      appendAudit: vi.fn().mockRejectedValue(new Error('disk full')),
    };
    const onError = vi.fn();
    const auditor = new Auditor(drv as unknown as never, {
      mode: 'best-effort',
      onError,
    });
    await auditor.record({ action: 'class.published', target: 'X@1.0.0' });
    expect(onError).toHaveBeenCalledOnce();
    expect(drv.appendAudit).toHaveBeenCalledOnce();
  });
});
