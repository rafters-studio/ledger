/**
 * Ledger Audit - Pure Helpers
 *
 * ORM-agnostic functions for creating audit entries.
 * Depends only on context and uuidv7.
 */

import { uuidv7 } from "uuidv7";
import { getLedgerContext } from "./context.js";
import type { AuditLogEntry, LedgerContext } from "./types.js";

/**
 * Action types for audit logging.
 */
export type AuditAction = "INSERT" | "UPDATE" | "DELETE" | "SOFT_DELETE" | "RESTORE";

/**
 * Options for creating an audit entry.
 */
export interface AuditEntryOptions {
  /** Name of the table being modified */
  tableName: string;
  /** Primary key of the record */
  recordId: string;
  /** Type of operation */
  action: AuditAction;
  /** Data before the change (null for INSERT) */
  oldData?: Record<string, unknown> | null;
  /** Data after the change (null for DELETE) */
  newData?: Record<string, unknown> | null;
  /** Override context (uses AsyncLocalStorage context if not provided) */
  context?: LedgerContext | null;
}

/**
 * Create an audit log entry object.
 * This doesn't insert into the database - use `insertAuditEntry` for that.
 *
 * @param options - The audit entry options
 * @returns An audit log entry ready for insertion
 *
 * @example
 * ```typescript
 * const entry = createAuditEntry({
 *   tableName: 'users',
 *   recordId: 'user-123',
 *   action: 'UPDATE',
 *   oldData: { name: 'Old Name' },
 *   newData: { name: 'New Name' },
 * });
 * ```
 */
export function createAuditEntry(options: AuditEntryOptions): AuditLogEntry {
  const context = options.context ?? getLedgerContext();

  return {
    id: uuidv7(),
    tableName: options.tableName,
    recordId: options.recordId,
    action: options.action,
    oldData: options.oldData ?? null,
    newData: options.newData ?? null,
    userId: context?.userId ?? null,
    ip: context?.ip ?? null,
    userAgent: context?.userAgent ?? null,
    endpoint: context?.endpoint ?? null,
    requestId: context?.requestId ?? null,
    createdAt: new Date(),
  };
}
