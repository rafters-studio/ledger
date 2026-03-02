/**
 * Drizzle Ledger Soft Delete - SQLite / Cloudflare D1
 *
 * Column definitions for soft-delete in SQLite databases.
 *
 * @example
 * ```typescript
 * import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
 * import { softDeleteColumns } from 'drizzle-ledger/soft-delete/sqlite';
 *
 * export const users = sqliteTable('users', {
 *   id: text('id').primaryKey(),
 *   name: text('name'),
 *   ...softDeleteColumns,
 * });
 * ```
 */

import { integer, text } from "drizzle-orm/sqlite-core";

/** Soft-delete columns for SQLite: deletedAt (timestamp_ms) + deletedBy (text) */
export const softDeleteColumns = {
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  deletedBy: text("deleted_by"),
} as const;

/** Minimal soft-delete for SQLite: deletedAt only */
export const softDeleteTimestamp = {
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
} as const;
