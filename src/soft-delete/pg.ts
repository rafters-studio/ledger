/**
 * Drizzle Ledger Soft Delete - PostgreSQL
 *
 * Column definitions for soft-delete in PostgreSQL databases.
 *
 * @example
 * ```typescript
 * import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
 * import { softDeleteColumns } from '@rafters/ledger/soft-delete/pg';
 *
 * export const users = pgTable('users', {
 *   id: uuid('id').primaryKey().defaultRandom(),
 *   name: text('name'),
 *   ...softDeleteColumns,
 * });
 * ```
 */

import { text, timestamp } from "drizzle-orm/pg-core";

/** Soft-delete columns for Postgres: deletedAt (timestamptz) + deletedBy (text) */
export const softDeleteColumns = {
  deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
  deletedBy: text("deleted_by"),
} as const;

/** Minimal soft-delete for Postgres: deletedAt only */
export const softDeleteTimestamp = {
  deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
} as const;
