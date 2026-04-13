/**
 * Ledger Drizzle Adapter
 *
 * Drizzle ORM-coupled utilities for audit trail, soft-delete, and GDPR compliance.
 *
 * @packageDocumentation
 */

// Audit (Drizzle-coupled)
export {
  type AuditAction,
  type AuditEntryOptions,
  createAuditEntry,
  getRecordHistory,
  insertAuditEntry,
  logDelete,
  logInsert,
  logRestore,
  logSoftDelete,
  logUpdate,
} from "./audit.js";

// Audited Database
export { type AuditedDbConfig, createAuditedDb, getTableName, hasColumn } from "./db.js";

// GDPR (Drizzle-coupled)
export {
  anonymizeJsonData,
  DEFAULT_PII_FIELDS,
  isUserDataPurged,
  type PurgeConfig,
  type PurgeResult,
  purgeUserData,
} from "./gdpr.js";

// Logger
export {
  type AuditEntryInput,
  AuditLogger,
  type AuditLoggerConfig,
  extractRecordId,
  type ParsedQuery,
  parseQuery,
} from "./logger.js";

// Schema (SQLite default)
export {
  AUDIT_LOG_INDEXES,
  type AuditLog,
  type AuditLogInsert,
  type AuditLogSelect,
} from "./schema/index.js";

// Soft-delete (Drizzle query filters + pure helpers)
export {
  includingDeleted,
  isSoftDeleted,
  notDeleted,
  onlyDeleted,
  restoreValues,
  softDeleteValues,
  type WithSoftDelete,
  type WithSoftDeleteTimestamp,
} from "./soft-delete.js";
