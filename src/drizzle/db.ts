/**
 * Drizzle Ledger Audited Database
 *
 * Monkeypatches a Drizzle database instance to automatically
 * convert delete() calls to soft-delete for tables with deletedAt column.
 */

import { getLedgerContext } from "../core/context.js";
import { softDeleteValues } from "../core/soft-delete.js";

/**
 * Configuration for createAuditedDb.
 */
export interface AuditedDbConfig {
  /** Tables to exclude from soft-delete (will hard delete) */
  hardDeleteTables?: string[];
  /** Custom soft-delete values factory */
  softDeleteValuesFactory?: (deletedBy?: string | null) => {
    deletedAt: Date;
    deletedBy: string | null;
  };
}

/**
 * Check if a Drizzle table has a specific column.
 *
 * @param table - The Drizzle table object
 * @param columnName - The column name to check for
 * @returns true if the table has the column
 */
export function hasColumn(table: unknown, columnName: string): boolean {
  if (!table || typeof table !== "object") {
    return false;
  }

  const col = (table as Record<string, unknown>)[columnName];
  if (!col || typeof col !== "object") {
    return false;
  }

  return "name" in col;
}

/**
 * Get the table name from a Drizzle table object.
 *
 * @param table - The Drizzle table object
 * @returns The table name or null
 */
export function getTableName(table: unknown): string | null {
  if (!table || typeof table !== "object") {
    return null;
  }

  const tableObj = table as Record<string, unknown>;

  const nameSymbol = Symbol.for("drizzle:Name");
  if (nameSymbol in tableObj) {
    return tableObj[nameSymbol] as string;
  }

  if ("_" in tableObj && typeof tableObj._ === "object" && tableObj._ !== null) {
    const meta = tableObj._ as Record<string, unknown>;
    if ("name" in meta && typeof meta.name === "string") {
      return meta.name;
    }
  }

  return null;
}

interface DrizzleQuery {
  returning: () => DrizzleQuery;
  execute: () => Promise<unknown>;
}

interface DrizzleUpdateChain {
  set: (values: Record<string, unknown>) => {
    where: (condition: unknown) => DrizzleQuery;
  };
}

interface WithDeleteAndUpdate {
  delete: (table: unknown) => { where: (condition: unknown) => DrizzleQuery };
  update: (table: unknown) => DrizzleUpdateChain;
}

/**
 * Wraps a Drizzle database instance to automatically convert
 * delete() calls to soft-delete for tables with deletedAt column.
 *
 * @param db - The Drizzle database instance
 * @param config - Optional configuration
 * @returns The same database instance with monkeypatched delete()
 *
 * @example
 * ```typescript
 * import { drizzle } from 'drizzle-orm/d1';
 * import { createAuditedDb } from '@rafters/ledger/db';
 *
 * const baseDb = drizzle(env.DB);
 * export const db = createAuditedDb(baseDb);
 *
 * // Now db.delete(users) automatically becomes soft-delete
 * await db.delete(users).where(eq(users.id, userId));
 * // Actually executes: UPDATE users SET deleted_at = ?, deleted_by = ? WHERE id = ?
 * ```
 */
export function createAuditedDb<T extends WithDeleteAndUpdate>(db: T, config?: AuditedDbConfig): T {
  const originalDelete = db.delete.bind(db);
  const softDeleteFactory = config?.softDeleteValuesFactory ?? softDeleteValues;

  (db as WithDeleteAndUpdate).delete = (table: unknown) => {
    const tableName = getTableName(table);

    if (tableName && config?.hardDeleteTables?.includes(tableName)) {
      return originalDelete(table);
    }

    if (!hasColumn(table, "deletedAt")) {
      return originalDelete(table);
    }

    return {
      where: (condition: unknown) => {
        const context = getLedgerContext();
        const deleteValues = softDeleteFactory(context?.userId);
        return db.update(table).set(deleteValues).where(condition);
      },
    };
  };

  return db;
}
