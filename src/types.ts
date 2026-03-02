/**
 * Drizzle Ledger Types
 *
 * Core type definitions for audit trail and soft-delete functionality.
 */

/**
 * Context passed through AsyncLocalStorage for audit logging.
 * Contains information about who is performing the action and from where.
 */
export interface LedgerContext {
  /** User ID performing the action (null for system/anonymous) */
  userId: string | null;
  /** IP address of the request */
  ip: string | null;
  /** User agent string */
  userAgent: string | null;
  /** API endpoint or action identifier */
  endpoint: string | null;
  /** Optional request ID for tracing */
  requestId?: string;
  /** Optional additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Audit log entry representing a single database change.
 */
export interface AuditLogEntry {
  /** Unique identifier for this audit entry */
  id: string;
  /** Name of the table that was modified */
  tableName: string;
  /** Primary key of the affected record */
  recordId: string;
  /** Type of operation performed */
  action: "INSERT" | "UPDATE" | "DELETE" | "SOFT_DELETE" | "RESTORE";
  /** Data before the change (null for INSERT) */
  oldData: Record<string, unknown> | null;
  /** Data after the change (null for DELETE) */
  newData: Record<string, unknown> | null;
  /** User who performed the action */
  userId: string | null;
  /** IP address of the request */
  ip: string | null;
  /** User agent string */
  userAgent: string | null;
  /** API endpoint or action identifier */
  endpoint: string | null;
  /** Request ID for tracing */
  requestId: string | null;
  /** When the change occurred */
  createdAt: Date;
}

/**
 * Configuration options for the ledger.
 */
export interface LedgerConfig {
  /** Enable soft-delete functionality */
  softDelete?: boolean;
  /** Enable audit trail logging */
  audit?: boolean;
  /** Function to get the current context */
  getContext?: () => LedgerContext | null;
  /** Tables to exclude from audit logging */
  excludeTables?: string[];
  /** Whether to log SELECT queries (default: false) */
  logSelects?: boolean;
}

/**
 * Options for soft-delete columns.
 */
export interface SoftDeleteOptions {
  /** Column name for the deleted timestamp (default: 'deletedAt') */
  columnName?: string;
  /** Column name for who deleted (optional) */
  deletedByColumn?: string;
}

/**
 * Result of a soft-delete operation.
 */
export interface SoftDeleteResult<T> {
  /** The soft-deleted record */
  record: T;
  /** The audit log entry created */
  auditEntry: AuditLogEntry;
}

/**
 * Result of a restore operation.
 */
export interface RestoreResult<T> {
  /** The restored record */
  record: T;
  /** The audit log entry created */
  auditEntry: AuditLogEntry;
}
