/**
 * Ledger Core
 *
 * ORM-agnostic core utilities for audit trail, soft-delete, and GDPR compliance.
 *
 * @packageDocumentation
 */

// Types
export type {
  AuditLogEntry,
  LedgerConfig,
  LedgerContext,
  RestoreResult,
  SoftDeleteOptions,
  SoftDeleteResult,
} from "./types.js";

// Context
export {
  createLedgerContext,
  createSystemContext,
  getLedgerContext,
  hasLedgerContext,
  runWithLedgerContext,
} from "./context.js";

// Soft-delete (pure helpers)
export {
  isSoftDeleted,
  restoreValues,
  softDeleteValues,
  type WithSoftDelete,
  type WithSoftDeleteTimestamp,
} from "./soft-delete.js";

// Audit (pure helpers)
export { type AuditAction, type AuditEntryOptions, createAuditEntry } from "./audit.js";

// GDPR (pure helpers)
export {
  anonymizeJsonData,
  DEFAULT_PII_FIELDS,
  type PurgeConfig,
  type PurgeResult,
} from "./gdpr.js";

// Errors
export { isSoftDeletePerformed, SoftDeletePerformedError } from "./errors.js";
