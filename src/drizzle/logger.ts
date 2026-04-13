/**
 * Drizzle Ledger Logger
 *
 * A Drizzle Logger implementation that captures query information
 * for audit logging purposes.
 */

import type { Logger } from "drizzle-orm";
import { getLedgerContext } from "../core/context.js";

/**
 * Parsed query information.
 */
export interface ParsedQuery {
  action: "INSERT" | "UPDATE" | "DELETE" | "SELECT";
  table: string;
}

/**
 * Input for audit entry callback.
 */
export interface AuditEntryInput {
  tableName: string;
  recordId: string | null;
  action: "INSERT" | "UPDATE" | "DELETE" | "SELECT";
  query: string;
  params: unknown[];
  userId: string | null;
  ip: string | null;
  userAgent: string | null;
  endpoint: string | null;
  requestId: string | undefined;
}

/**
 * Configuration for AuditLogger.
 */
export interface AuditLoggerConfig {
  /** Tables to audit (if empty, audits all tables) */
  includeTables?: string[];
  /** Tables to exclude from auditing */
  excludeTables?: string[];
  /** Whether to log SELECT queries (default: false) */
  logSelects?: boolean;
}

/**
 * Parse a SQL query to extract the action and table name.
 *
 * @param query - The SQL query string
 * @returns Parsed query info or null if unparseable
 */
export function parseQuery(query: string): ParsedQuery | null {
  const normalized = query.trim().toUpperCase();

  // INSERT INTO table_name
  const insertMatch = normalized.match(/^INSERT\s+INTO\s+[`"']?(\w+)[`"']?/i);
  if (insertMatch?.[1]) {
    return { action: "INSERT", table: insertMatch[1].toLowerCase() };
  }

  // UPDATE table_name
  const updateMatch = normalized.match(/^UPDATE\s+[`"']?(\w+)[`"']?/i);
  if (updateMatch?.[1]) {
    return { action: "UPDATE", table: updateMatch[1].toLowerCase() };
  }

  // DELETE FROM table_name
  const deleteMatch = normalized.match(/^DELETE\s+FROM\s+[`"']?(\w+)[`"']?/i);
  if (deleteMatch?.[1]) {
    return { action: "DELETE", table: deleteMatch[1].toLowerCase() };
  }

  // SELECT ... FROM table_name
  const selectMatch = normalized.match(/^SELECT\s+.+?\s+FROM\s+[`"']?(\w+)[`"']?/i);
  if (selectMatch?.[1]) {
    return { action: "SELECT", table: selectMatch[1].toLowerCase() };
  }

  return null;
}

/**
 * Try to extract a record ID from query params.
 * This is a best-effort extraction - not all queries will have identifiable record IDs.
 *
 * @param params - Query parameters
 * @returns The first string parameter that looks like an ID, or null
 */
export function extractRecordId(params: unknown[]): string | null {
  for (const param of params) {
    if (typeof param === "string" && param.length > 0 && param.length < 100) {
      // Looks like a UUID or ID
      if (/^[a-f0-9-]{20,}$/i.test(param) || /^[a-z0-9_-]+$/i.test(param)) {
        return param;
      }
    }
  }
  return null;
}

/**
 * Drizzle Logger that writes to an audit trail.
 *
 * @example
 * ```typescript
 * const logger = new AuditLogger(
 *   async (entry) => {
 *     await db.insert(auditLog).values({
 *       id: uuidv7(),
 *       ...entry,
 *       createdAt: new Date(),
 *     });
 *   },
 *   { excludeTables: ['audit_log', 'session'] }
 * );
 *
 * const db = drizzle(d1, { logger });
 * ```
 */
export class AuditLogger implements Logger {
  constructor(
    private writeAuditEntry: (entry: AuditEntryInput) => Promise<void>,
    private config?: AuditLoggerConfig,
  ) {}

  logQuery(query: string, params: unknown[]): void {
    const parsed = parseQuery(query);
    if (!parsed) {
      return;
    }

    // Skip SELECT unless configured to log them
    if (parsed.action === "SELECT" && !this.config?.logSelects) {
      return;
    }

    // Check include/exclude tables
    if (this.config?.includeTables?.length) {
      if (!this.config.includeTables.includes(parsed.table)) {
        return;
      }
    }

    if (this.config?.excludeTables?.includes(parsed.table)) {
      return;
    }

    // Get context from AsyncLocalStorage
    const context = getLedgerContext();

    // Fire and forget - don't await, don't block the query
    this.writeAuditEntry({
      tableName: parsed.table,
      recordId: extractRecordId(params),
      action: parsed.action,
      query,
      params,
      userId: context?.userId ?? null,
      ip: context?.ip ?? null,
      userAgent: context?.userAgent ?? null,
      endpoint: context?.endpoint ?? null,
      requestId: context?.requestId,
    }).catch((err) => {
      // Log error but don't throw - audit failures shouldn't break the app
      console.error("[ledger] Failed to write audit entry:", err);
    });
  }
}
