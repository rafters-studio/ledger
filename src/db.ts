/**
 * Drizzle Ledger Audited Database
 *
 * Monkeypatches a Drizzle database instance to automatically
 * convert delete() calls to soft-delete for tables with deletedAt column.
 */

import { getLedgerContext } from "./context.js";
import { softDeleteValues } from "./soft-delete/index.js";

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

interface WithDeleteAndUpdate {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete: (table: any) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update: (table: any) => any;
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
 * import { createAuditedDb } from 'drizzle-ledger/db';
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as WithDeleteAndUpdate).delete = (table: any) => {
    const tableName = getTableName(table);

    if (tableName && config?.hardDeleteTables?.includes(tableName)) {
      return originalDelete(table);
    }

    if (!hasColumn(table, "deletedAt")) {
      return originalDelete(table);
    }

    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: (condition: any) => {
        const context = getLedgerContext();
        const deleteValues = softDeleteFactory(context?.userId);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const updateQuery = (db.update as any)(table).set(deleteValues).where(condition);

        return {
          returning: () => updateQuery.returning(),
          execute: () => updateQuery.execute(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          then: (onfulfilled?: (value: any) => any) => updateQuery.then(onfulfilled),
        };
      },
    };
  };

  return db;
}
