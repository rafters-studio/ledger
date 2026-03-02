/**
 * Drizzle Ledger Schema - PostgreSQL
 *
 * Audit log table definition for PostgreSQL databases.
 *
 * @example
 * ```typescript
 * export { auditLog } from 'drizzle-ledger/schema/pg';
 * ```
 */

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const auditLog = pgTable("audit_log", {
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
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
});

export function createAuditLogTable(tableName: string) {
  return pgTable(tableName, {
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
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
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
