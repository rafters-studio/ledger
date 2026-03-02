/**
 * Drizzle Ledger Schema - MySQL
 *
 * Audit log table definition for MySQL databases.
 *
 * @example
 * ```typescript
 * export { auditLog } from '@ezmode-games/drizzle-ledger/schema/mysql';
 * ```
 */

import { mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

export const auditLog = mysqlTable("audit_log", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tableName: varchar("table_name", { length: 255 }).notNull(),
  recordId: varchar("record_id", { length: 255 }).notNull(),
  action: varchar("action", { length: 20 }).notNull(),
  oldData: text("old_data"),
  newData: text("new_data"),
  userId: varchar("user_id", { length: 255 }),
  ip: varchar("ip", { length: 45 }),
  userAgent: text("user_agent"),
  endpoint: varchar("endpoint", { length: 500 }),
  requestId: varchar("request_id", { length: 255 }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

export function createAuditLogTable(tableName: string) {
  return mysqlTable(tableName, {
    id: varchar("id", { length: 36 }).primaryKey(),
    tableName: varchar("table_name", { length: 255 }).notNull(),
    recordId: varchar("record_id", { length: 255 }).notNull(),
    action: varchar("action", { length: 20 }).notNull(),
    oldData: text("old_data"),
    newData: text("new_data"),
    userId: varchar("user_id", { length: 255 }),
    ip: varchar("ip", { length: 45 }),
    userAgent: text("user_agent"),
    endpoint: varchar("endpoint", { length: 500 }),
    requestId: varchar("request_id", { length: 255 }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  });
}

export type AuditLog = typeof auditLog;
export type AuditLogInsert = typeof auditLog.$inferInsert;
export type AuditLogSelect = typeof auditLog.$inferSelect;

export const AUDIT_LOG_INDEXES = [
  "CREATE INDEX idx_audit_log_table_record ON audit_log(table_name, record_id)",
  "CREATE INDEX idx_audit_log_user ON audit_log(user_id)",
  "CREATE INDEX idx_audit_log_created ON audit_log(created_at)",
  "CREATE INDEX idx_audit_log_request ON audit_log(request_id)",
] as const;
