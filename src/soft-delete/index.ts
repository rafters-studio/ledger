/**
 * Drizzle Ledger Soft Delete
 *
 * Dialect-agnostic helpers for implementing soft-delete patterns in Drizzle.
 * For column definitions, import from the dialect-specific module:
 * - drizzle-ledger/soft-delete/sqlite
 * - drizzle-ledger/soft-delete/pg
 * - drizzle-ledger/soft-delete/mysql
 */

import { type Column, isNotNull, isNull, type SQL, sql } from "drizzle-orm";

/**
 * Filter condition to exclude soft-deleted records.
 * Use this in your WHERE clauses to only get active records.
 *
 * @param table - The table with a deletedAt column
 * @returns SQL condition for non-deleted records
 *
 * @example
 * ```typescript
 * import { notDeleted } from 'drizzle-ledger/soft-delete';
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

/**
 * Values to set when soft-deleting a record.
 *
 * @param deletedBy - Optional user ID who is deleting the record
 * @returns Object with deletedAt set to current timestamp
 */
export function softDeleteValues(deletedBy?: string | null): {
  deletedAt: Date;
  deletedBy: string | null;
} {
  return {
    deletedAt: new Date(),
    deletedBy: deletedBy ?? null,
  };
}

/**
 * Values to set when restoring a soft-deleted record.
 *
 * @returns Object with deletedAt and deletedBy set to null
 */
export function restoreValues(): {
  deletedAt: null;
  deletedBy: null;
} {
  return {
    deletedAt: null,
    deletedBy: null,
  };
}

/**
 * Check if a record is soft-deleted.
 *
 * @param record - A record with a deletedAt field
 * @returns true if the record is soft-deleted
 */
export function isSoftDeleted(record: { deletedAt: Date | null } | null | undefined): boolean {
  return record?.deletedAt !== null && record?.deletedAt !== undefined;
}

/**
 * Type helper to add soft-delete columns to a table type.
 */
export type WithSoftDelete<T> = T & {
  deletedAt: Date | null;
  deletedBy: string | null;
};

/**
 * Type helper for minimal soft-delete (just timestamp).
 */
export type WithSoftDeleteTimestamp<T> = T & {
  deletedAt: Date | null;
};
