/**
 * Drizzle Ledger
 *
 * Soft-delete, audit trail, and GDPR compliance for Drizzle ORM.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * // 1. Add soft-delete columns to your tables
 * import { softDeleteColumns } from '@ezmode-games/drizzle-ledger/soft-delete/sqlite';
 *
 * export const users = sqliteTable('users', {
 *   id: text('id').primaryKey(),
 *   name: text('name'),
 *   ...softDeleteColumns,
 * });
 *
 * // 2. Add the audit log table to your schema
 * export { auditLog } from '@ezmode-games/drizzle-ledger/schema/sqlite';
 *
 * // 3. Set up context in your middleware
 * import { runWithLedgerContext, createLedgerContext } from '@ezmode-games/drizzle-ledger/context';
 *
 * app.use(async (c, next) => {
 *   const context = createLedgerContext({
 *     userId: c.get('user')?.id,
 *     ip: c.req.header('x-forwarded-for'),
 *     userAgent: c.req.header('user-agent'),
 *     endpoint: `${c.req.method} ${c.req.path}`,
 *   });
 *   return runWithLedgerContext(context, next);
 * });
 *
 * // 4. Use soft-delete in queries
 * import { notDeleted, softDeleteValues } from '@ezmode-games/drizzle-ledger/soft-delete';
 *
 * const activeUsers = await db.select().from(users).where(notDeleted(users));
 * ```
 */

// Audit
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

// Better Auth Plugin
export {
  createDeleteAuditCallback,
  createSoftDeleteCallback,
  isSoftDeletePerformed,
  type LedgerAuditEntry,
  type LedgerPluginConfig,
  ledgerPlugin,
  type SoftDeleteCallbackOptions,
  SoftDeletePerformedError,
} from "./better-auth.js";

// Context
export {
  createLedgerContext,
  createSystemContext,
  getLedgerContext,
  hasLedgerContext,
  runWithLedgerContext,
} from "./context.js";

// GDPR
export {
  anonymizeJsonData,
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

// Soft-delete (dialect-agnostic helpers)
export {
  includingDeleted,
  isSoftDeleted,
  notDeleted,
  onlyDeleted,
  restoreValues,
  softDeleteValues,
  type WithSoftDelete,
  type WithSoftDeleteTimestamp,
} from "./soft-delete/index.js";

// Types
export type {
  AuditLogEntry,
  LedgerConfig,
  LedgerContext,
  RestoreResult,
  SoftDeleteOptions,
  SoftDeleteResult,
} from "./types.js";
