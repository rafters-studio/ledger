/**
 * Drizzle Ledger Audit
 *
 * Functions for logging database changes to an audit trail.
 * Automatically captures context from AsyncLocalStorage.
 */

import type { auditLog } from "./schema/sqlite.js";
import type { AuditLogEntry } from "./core/types.js";

// Re-export pure helpers from core
export { type AuditAction, type AuditEntryOptions, createAuditEntry } from "./core/audit.js";

/**
 * Insert an audit log entry into the database.
 *
 * @param db - Drizzle database instance or transaction
 * @param auditTable - The audit log table
 * @param entry - The audit entry to insert
 *
 * @example
 * ```typescript
 * await insertAuditEntry(db, auditLog, entry);
 * ```
 */
export async function insertAuditEntry(
  db: {
    insert: (table: typeof auditLog) => {
      values: (entry: unknown) => { execute: () => Promise<unknown> };
    };
  },
  auditTable: typeof auditLog,
  entry: AuditLogEntry,
): Promise<void> {
  await db
    .insert(auditTable)
    .values({
      id: entry.id,
      tableName: entry.tableName,
      recordId: entry.recordId,
      action: entry.action,
      oldData: entry.oldData ? JSON.stringify(entry.oldData) : null,
      newData: entry.newData ? JSON.stringify(entry.newData) : null,
      userId: entry.userId,
      ip: entry.ip,
      userAgent: entry.userAgent,
      endpoint: entry.endpoint,
      requestId: entry.requestId,
      createdAt: entry.createdAt,
    })
    .execute();
}

/**
 * Log an INSERT operation.
 *
 * @param db - Drizzle database instance
 * @param auditTable - The audit log table
 * @param tableName - Name of the table where record was inserted
 * @param recordId - Primary key of the inserted record
 * @param newData - The inserted data
 *
 * @example
 * ```typescript
 * // After inserting a user
 * const [user] = await db.insert(users).values(userData).returning();
 * await logInsert(db, auditLog, 'users', user.id, user);
 * ```
 */
export async function logInsert(
  db: Parameters<typeof insertAuditEntry>[0],
  auditTable: typeof auditLog,
  tableName: string,
  recordId: string,
  newData: Record<string, unknown>,
): Promise<AuditLogEntry> {
  const { createAuditEntry } = await import("./core/audit.js");
  const entry = createAuditEntry({
    tableName,
    recordId,
    action: "INSERT",
    oldData: null,
    newData,
  });
  await insertAuditEntry(db, auditTable, entry);
  return entry;
}

/**
 * Log an UPDATE operation.
 *
 * @param db - Drizzle database instance
 * @param auditTable - The audit log table
 * @param tableName - Name of the table where record was updated
 * @param recordId - Primary key of the updated record
 * @param oldData - Data before the update
 * @param newData - Data after the update
 *
 * @example
 * ```typescript
 * // Before updating, fetch the old data
 * const [oldUser] = await db.select().from(users).where(eq(users.id, id));
 * const [newUser] = await db.update(users).set(changes).where(eq(users.id, id)).returning();
 * await logUpdate(db, auditLog, 'users', id, oldUser, newUser);
 * ```
 */
export async function logUpdate(
  db: Parameters<typeof insertAuditEntry>[0],
  auditTable: typeof auditLog,
  tableName: string,
  recordId: string,
  oldData: Record<string, unknown>,
  newData: Record<string, unknown>,
): Promise<AuditLogEntry> {
  const { createAuditEntry } = await import("./core/audit.js");
  const entry = createAuditEntry({
    tableName,
    recordId,
    action: "UPDATE",
    oldData,
    newData,
  });
  await insertAuditEntry(db, auditTable, entry);
  return entry;
}

/**
 * Log a DELETE operation (hard delete).
 *
 * @param db - Drizzle database instance
 * @param auditTable - The audit log table
 * @param tableName - Name of the table where record was deleted
 * @param recordId - Primary key of the deleted record
 * @param oldData - Data before deletion
 *
 * @example
 * ```typescript
 * // Before deleting, fetch the data
 * const [user] = await db.select().from(users).where(eq(users.id, id));
 * await db.delete(users).where(eq(users.id, id));
 * await logDelete(db, auditLog, 'users', id, user);
 * ```
 */
export async function logDelete(
  db: Parameters<typeof insertAuditEntry>[0],
  auditTable: typeof auditLog,
  tableName: string,
  recordId: string,
  oldData: Record<string, unknown>,
): Promise<AuditLogEntry> {
  const { createAuditEntry } = await import("./core/audit.js");
  const entry = createAuditEntry({
    tableName,
    recordId,
    action: "DELETE",
    oldData,
    newData: null,
  });
  await insertAuditEntry(db, auditTable, entry);
  return entry;
}

/**
 * Log a SOFT_DELETE operation.
 *
 * @param db - Drizzle database instance
 * @param auditTable - The audit log table
 * @param tableName - Name of the table where record was soft-deleted
 * @param recordId - Primary key of the soft-deleted record
 * @param oldData - Data before soft-delete
 * @param newData - Data after soft-delete (with deletedAt set)
 *
 * @example
 * ```typescript
 * const [oldUser] = await db.select().from(users).where(eq(users.id, id));
 * const [newUser] = await db.update(users)
 *   .set(softDeleteValues(currentUserId))
 *   .where(eq(users.id, id))
 *   .returning();
 * await logSoftDelete(db, auditLog, 'users', id, oldUser, newUser);
 * ```
 */
export async function logSoftDelete(
  db: Parameters<typeof insertAuditEntry>[0],
  auditTable: typeof auditLog,
  tableName: string,
  recordId: string,
  oldData: Record<string, unknown>,
  newData: Record<string, unknown>,
): Promise<AuditLogEntry> {
  const { createAuditEntry } = await import("./core/audit.js");
  const entry = createAuditEntry({
    tableName,
    recordId,
    action: "SOFT_DELETE",
    oldData,
    newData,
  });
  await insertAuditEntry(db, auditTable, entry);
  return entry;
}

/**
 * Log a RESTORE operation (un-soft-delete).
 *
 * @param db - Drizzle database instance
 * @param auditTable - The audit log table
 * @param tableName - Name of the table where record was restored
 * @param recordId - Primary key of the restored record
 * @param oldData - Data before restore (with deletedAt set)
 * @param newData - Data after restore (with deletedAt null)
 *
 * @example
 * ```typescript
 * const [oldUser] = await db.select().from(users).where(eq(users.id, id));
 * const [newUser] = await db.update(users)
 *   .set(restoreValues())
 *   .where(eq(users.id, id))
 *   .returning();
 * await logRestore(db, auditLog, 'users', id, oldUser, newUser);
 * ```
 */
export async function logRestore(
  db: Parameters<typeof insertAuditEntry>[0],
  auditTable: typeof auditLog,
  tableName: string,
  recordId: string,
  oldData: Record<string, unknown>,
  newData: Record<string, unknown>,
): Promise<AuditLogEntry> {
  const { createAuditEntry } = await import("./core/audit.js");
  const entry = createAuditEntry({
    tableName,
    recordId,
    action: "RESTORE",
    oldData,
    newData,
  });
  await insertAuditEntry(db, auditTable, entry);
  return entry;
}

/**
 * Get audit history for a specific record.
 *
 * @param db - Drizzle database instance
 * @param auditTable - The audit log table
 * @param tableName - Name of the table
 * @param recordId - Primary key of the record
 * @returns Array of audit entries for the record, newest first
 *
 * @example
 * ```typescript
 * const history = await getRecordHistory(db, auditLog, 'users', 'user-123');
 * for (const entry of history) {
 *   console.log(`${entry.action} by ${entry.userId} at ${entry.createdAt}`);
 * }
 * ```
 */
export async function getRecordHistory(
  db: {
    select: () => {
      from: (table: typeof auditLog) => {
        where: (condition: unknown) => {
          orderBy: (order: unknown) => Promise<Array<typeof auditLog.$inferSelect>>;
        };
      };
    };
  },
  auditTable: typeof auditLog,
  tableName: string,
  recordId: string,
): Promise<AuditLogEntry[]> {
  const { and, eq, desc } = await import("drizzle-orm");

  const results = await db
    .select()
    .from(auditTable)
    .where(and(eq(auditTable.tableName, tableName), eq(auditTable.recordId, recordId)))
    .orderBy(desc(auditTable.createdAt));

  return results.map((row) => ({
    id: row.id,
    tableName: row.tableName,
    recordId: row.recordId,
    action: row.action,
    oldData: row.oldData ? JSON.parse(row.oldData) : null,
    newData: row.newData ? JSON.parse(row.newData) : null,
    userId: row.userId,
    ip: row.ip,
    userAgent: row.userAgent,
    endpoint: row.endpoint,
    requestId: row.requestId,
    createdAt: row.createdAt,
  }));
}
