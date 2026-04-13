/**
 * Drizzle Ledger Schema - SQLite / Cloudflare D1
 *
 * Audit log table definition for SQLite databases.
 *
 * @example
 * ```typescript
 * // In your schema file
 * export { auditLog } from '@rafters/ledger/schema/sqlite';
 *
 * // Or customize the table name
 * import { createAuditLogTable } from '@rafters/ledger/schema/sqlite';
 * export const auditLog = createAuditLogTable('custom_audit_log');
 * ```
 */

import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  tableName: text("table_name").notNull(),
  recordId: text("record_id").notNull(),
  action: text("action", {
    enum: ["INSERT", "UPDATE", "DELETE", "SOFT_DELETE", "RESTORE"],
  }).notNull(),
  oldData: text("old_data"),
  newData: text("new_data"),
  userId: text("user_id"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  endpoint: text("endpoint"),
  requestId: text("request_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export function createAuditLogTable(tableName: string) {
  return sqliteTable(tableName, {
    id: text("id").primaryKey(),
    tableName: text("table_name").notNull(),
    recordId: text("record_id").notNull(),
    action: text("action", {
      enum: ["INSERT", "UPDATE", "DELETE", "SOFT_DELETE", "RESTORE"],
    }).notNull(),
    oldData: text("old_data"),
    newData: text("new_data"),
    userId: text("user_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    endpoint: text("endpoint"),
    requestId: text("request_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  });
}

export type AuditLog = typeof auditLog;
export type AuditLogInsert = typeof auditLog.$inferInsert;
export type AuditLogSelect = typeof auditLog.$inferSelect;

export const AUDIT_LOG_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_audit_log_table_record ON audit_log(table_name, record_id)",
  "CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_audit_log_request ON audit_log(request_id)",
] as const;
