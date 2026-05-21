/**
 * Public entry point for the audit module.
 */
export { Auditor, NoopAuditor, type AuditorOptions, type RecordInput } from './auditor.js';
export { AUDIT_ACTIONS, AuditWriteError, type AuditActionName, type AuditMode } from './types.js';
