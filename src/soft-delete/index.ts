/**
 * Drizzle Ledger Soft Delete
 *
 * Dialect-agnostic helpers for implementing soft-delete patterns in Drizzle.
 * For column definitions, import from the dialect-specific module:
 * - ledger/soft-delete/sqlite
 * - ledger/soft-delete/pg
 * - ledger/soft-delete/mysql
 */

import { type Column, isNotNull, isNull, type SQL, sql } from "drizzle-orm";

// Re-export pure helpers from core
export {
  isSoftDeleted,
  restoreValues,
  softDeleteValues,
  type WithSoftDelete,
  type WithSoftDeleteTimestamp,
} from "../core/soft-delete.js";

/**
 * Filter condition to exclude soft-deleted records.
 * Use this in your WHERE clauses to only get active records.
 *
 * @param table - The table with a deletedAt column
 * @returns SQL condition for non-deleted records
 *
 * @example
 * ```typescript
 * import { notDeleted } from '@rafters/ledger/soft-delete';
 *
 * const users = await db
 *   .select()
 *   .from(usersTable)
 *   .where(notDeleted(usersTable));
 * ```
 */
export function notDeleted<T extends { deletedAt: Column }>(table: T): SQL {
  return isNull(table.deletedAt);
}

/**
 * Filter condition to only get soft-deleted records.
 * Useful for "trash" views or admin interfaces.
 *
 * @param table - The table with a deletedAt column
 * @returns SQL condition for deleted records only
 */
export function onlyDeleted<T extends { deletedAt: Column }>(table: T): SQL {
  return isNotNull(table.deletedAt);
}

/**
 * Filter condition to get all records including soft-deleted ones.
 * Returns a SQL fragment that's always true.
 *
 * @returns SQL condition that matches all records
 */
export function includingDeleted(): SQL {
  return sql`1=1`;
}
