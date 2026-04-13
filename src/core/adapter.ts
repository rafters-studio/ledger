/**
 * Ledger Adapter Interface
 *
 * Defines the contract that any ORM adapter must satisfy.
 * TypeScript structural typing handles conformance -- no runtime enforcement needed.
 *
 * Generic parameters:
 * - TDb: The database instance type (e.g., DrizzleSQLiteDatabase)
 * - TAuditTable: The audit log table reference type (e.g., typeof auditLog)
 * - TQueryFilter: The query filter/condition type returned by filter functions (e.g., SQL)
 */

import type { AuditLogEntry } from "./types.js";
import type { PurgeConfig, PurgeResult } from "./gdpr.js";

/**
 * Configuration for audited database wrapping.
 * Adapter implementations may extend this with ORM-specific options.
 */
export interface AuditedDbConfig {
  /** Tables to exclude from soft-delete (will hard delete) */
  hardDeleteTables?: string[];
}

/**
 * The contract every ORM adapter must implement.
 *
 * Each method corresponds to a capability the adapter provides.
 * Adapters are free to expose additional ORM-specific helpers
 * (e.g., logInsert, logUpdate, AuditLogger) beyond this contract.
 */
export interface LedgerAdapter<TDb, TAuditTable, TQueryFilter> {
  // -- Query filters --

  /**
   * Return a filter condition that excludes soft-deleted records.
   *
   * @param table - A table with a deletedAt column
   * @returns A query filter for non-deleted records
   */
  notDeleted(table: { deletedAt: unknown }): TQueryFilter;

  /**
   * Return a filter condition that includes only soft-deleted records.
   *
   * @param table - A table with a deletedAt column
   * @returns A query filter for deleted records only
   */
  onlyDeleted(table: { deletedAt: unknown }): TQueryFilter;

  // -- Audit operations --

  /**
   * Persist an audit log entry to the database.
   *
   * @param db - The database instance
   * @param auditTable - The audit log table reference
   * @param entry - The audit entry to persist
   */
  insertAuditEntry(db: TDb, auditTable: TAuditTable, entry: AuditLogEntry): Promise<void>;

  /**
   * Retrieve the full audit history for a specific record, newest first.
   *
   * @param db - The database instance
   * @param auditTable - The audit log table reference
   * @param tableName - Name of the table the record belongs to
   * @param recordId - Primary key of the record
   * @returns Audit entries ordered by creation time descending
   */
  getRecordHistory(
    db: TDb,
    auditTable: TAuditTable,
    tableName: string,
    recordId: string,
  ): Promise<AuditLogEntry[]>;

  // -- GDPR --

  /**
   * Anonymize all audit data for a given user.
   * Preserves audit trail structure but removes PII.
   *
   * @param db - The database instance
   * @param auditTable - The audit log table reference
   * @param userId - The user whose data should be purged
   * @param config - Optional purge configuration
   * @returns Result with count of affected records
   */
  purgeUserData(
    db: TDb,
    auditTable: TAuditTable,
    userId: string,
    config?: PurgeConfig,
  ): Promise<PurgeResult>;

  /**
   * Check whether a user's data has already been purged.
   *
   * @param db - The database instance
   * @param auditTable - The audit log table reference
   * @param userId - The user to check
   * @returns true if no audit entries remain with this userId
   */
  isUserDataPurged(db: TDb, auditTable: TAuditTable, userId: string): Promise<boolean>;

  // -- Soft-delete automation --

  /**
   * Wrap a database instance so that delete() calls are automatically
   * converted to soft-delete for tables with a deletedAt column.
   *
   * @param db - The database instance to wrap
   * @param config - Optional configuration
   * @returns The wrapped database instance (same type as input)
   */
  createAuditedDb(db: TDb, config?: AuditedDbConfig): TDb;
}
