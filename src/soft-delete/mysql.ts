/**
 * Drizzle Ledger Soft Delete - MySQL
 *
 * Column definitions for soft-delete in MySQL databases.
 *
 * @example
 * ```typescript
 * import { mysqlTable, varchar } from 'drizzle-orm/mysql-core';
 * import { softDeleteColumns } from 'drizzle-ledger/soft-delete/mysql';
 *
 * export const users = mysqlTable('users', {
 *   id: varchar('id', { length: 36 }).primaryKey(),
 *   name: varchar('name', { length: 255 }),
 *   ...softDeleteColumns,
 * });
 * ```
 */

import { timestamp, varchar } from "drizzle-orm/mysql-core";

/** Soft-delete columns for MySQL: deletedAt (timestamp) + deletedBy (varchar) */
export const softDeleteColumns = {
  deletedAt: timestamp("deleted_at", { mode: "date" }),
  deletedBy: varchar("deleted_by", { length: 255 }),
} as const;

/** Minimal soft-delete for MySQL: deletedAt only */
export const softDeleteTimestamp = {
  deletedAt: timestamp("deleted_at", { mode: "date" }),
} as const;
