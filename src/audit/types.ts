/**
 * Audit action vocabulary.
 *
 * Each privileged action funnels through `Auditor.record(...)`; the
 * action string is the controlled vocabulary. Adding a new action is
 * an ADR-worthy decision — the dashboards in Phase 8 lean on this
 * being stable.
 */
export const AUDIT_ACTIONS = {
  CLASS_PUBLISHED: 'class.published',
  CLASS_DEPRECATED: 'class.deprecated',
  CLASS_SIGNED: 'class.signed',
  ACTOR_TOMBSTONED: 'actor.tombstoned',
  ACTOR_MIGRATED: 'actor.migrated',
  POLICY_CHANGED: 'policy.changed',
  SIGNING_KEY_ADDED: 'signing-key.added',
  SIGNING_KEY_REVOKED: 'signing-key.revoked',
  CAPABILITY_MINTED: 'capability.minted',
  CAPABILITY_REVOKED: 'capability.revoked',
  ADMIN_RPC: 'admin.rpc',
} as const;

export type AuditActionName = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * Strictness controls whether a failed audit write fails the action.
 *
 * - `strict`: an audit write failure throws and the caller propagates
 *   the error, aborting the privileged action. Recommended default
 *   for compliance-sensitive deployments.
 * - `best-effort`: the audit failure is logged but the action
 *   completes. Use only for environments where availability is
 *   more important than completeness of the log.
 */
export type AuditMode = 'strict' | 'best-effort';

export class AuditWriteError extends Error {
  readonly code = 'AuditWriteFailed';
  override readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'AuditWriteError';
    this.cause = cause;
  }
}
