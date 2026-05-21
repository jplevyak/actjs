/**
 * `Auditor` — thin wrapper around `StorageDriver.appendAudit`.
 *
 * Every privileged action funnels through `Auditor.record(...)`. The
 * wrapper takes a {@link Principal} (so callers don't have to
 * stringify it) and applies the strict-write policy: by default an
 * audit failure aborts the action.
 *
 * Use `forSubsystem(name)` to get an instance pre-bound to a
 * subsystem string (used as a fallback principal when none is
 * supplied — e.g. system-initiated migrations).
 */
import { randomUUID } from 'node:crypto';

import type { AuditEntry, StorageDriver } from '../storage/driver.js';
import { isSystem, type Principal } from '../types/principal.js';

import { AUDIT_ACTIONS, AuditWriteError, type AuditMode } from './types.js';

export interface AuditorOptions {
  /** Strict (default) or best-effort. */
  readonly mode?: AuditMode;
  /** Test seam: clock. */
  readonly nowMs?: () => number;
  /** Test seam: id source. */
  readonly nextId?: () => string;
  /** Optional structured logger for best-effort failures. */
  readonly onError?: (err: unknown, entry: PendingEntry) => void;
}

export interface PendingEntry {
  readonly principal: string;
  readonly action: string;
  readonly target: string;
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface RecordInput {
  readonly action: string;
  readonly target: string;
  readonly meta?: Readonly<Record<string, unknown>>;
  /** Override the principal subject. Defaults to a derived value. */
  readonly principal?: Principal | string;
}

export class Auditor {
  private readonly driver: StorageDriver;
  private readonly mode: AuditMode;
  private readonly now: () => number;
  private readonly nextId: () => string;
  private readonly onError: ((err: unknown, entry: PendingEntry) => void) | undefined;

  constructor(driver: StorageDriver, options: AuditorOptions = {}) {
    this.driver = driver;
    this.mode = options.mode ?? 'strict';
    this.now = options.nowMs ?? Date.now;
    this.nextId = options.nextId ?? randomUUID;
    this.onError = options.onError;
  }

  /** Strict (default) or best-effort. */
  get strict(): boolean {
    return this.mode === 'strict';
  }

  /**
   * Record an audit entry. Strict mode (default) throws an
   * {@link AuditWriteError} on failure; best-effort mode invokes the
   * `onError` callback (if any) and swallows.
   */
  async record(input: RecordInput): Promise<void> {
    const principal = derivePrincipal(input.principal);
    const entry: AuditEntry = {
      id: this.nextId(),
      ts: this.now(),
      principal,
      action: input.action,
      target: input.target,
      meta: input.meta ?? {},
    };
    try {
      await this.driver.appendAudit(entry);
    } catch (err) {
      const pending: PendingEntry = {
        principal,
        action: input.action,
        target: input.target,
        meta: input.meta ?? {},
      };
      if (this.onError) this.onError(err, pending);
      if (this.mode === 'strict') {
        throw new AuditWriteError(
          `audit write failed for ${input.action} on ${input.target}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          err,
        );
      }
    }
  }
}

/**
 * No-op auditor — used by code paths that haven't been handed an
 * audit dependency. The internal call sites that *should* audit go
 * through a real {@link Auditor}; this exists so unit tests can
 * instantiate a Runtime without wiring one up.
 */
export class NoopAuditor extends Auditor {
  constructor() {
    super(
      {
        appendAudit: async () => undefined,
      } as unknown as StorageDriver,
      { mode: 'best-effort' },
    );
  }

  override async record(_input: RecordInput): Promise<void> {
    return;
  }
}

function derivePrincipal(input: Principal | string | undefined): string {
  if (!input) return 'anonymous';
  if (typeof input === 'string') return input;
  if (isSystem(input)) return 'system';
  return input.sub;
}

export { AUDIT_ACTIONS };
