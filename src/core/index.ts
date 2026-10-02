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
  ValueFreeAuditEntry,
} from "./types.js";

// Adapter interface
export type { LedgerAdapter } from "./adapter.js";

// Context
export {
  assertLedgerContextAvailable,
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

// Redaction (pure helpers)
export { DEFAULT_SECRET_PATTERNS, REDACTED_VALUE, redactSensitiveFields } from "./redact.js";

// GDPR (pure helpers)
export {
  anonymizeJsonData,
  DEFAULT_PII_FIELDS,
  type PurgeConfig,
  type PurgeResult,
} from "./gdpr.js";

// Errors
export {
  AuditTableDeleteError,
  isSoftDeletePerformed,
  LedgerContextUnavailableError,
  MissingSoftDeleteColumnError,
  SoftDeletePerformedError,
  UnresolvedSoftDeleteTableError,
} from "./errors.js";
