/**
 * Drizzle Ledger
 *
 * Soft-delete, audit trail, and GDPR compliance for Drizzle ORM.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * // 1. Add soft-delete columns to your tables
 * import { softDeleteColumns } from '@rafters/ledger/soft-delete/sqlite';
 *
 * export const users = sqliteTable('users', {
 *   id: text('id').primaryKey(),
 *   name: text('name'),
 *   ...softDeleteColumns,
 * });
 *
 * // 2. Add the audit log table to your schema
 * export { auditLog } from '@rafters/ledger/schema/sqlite';
 *
 * // 3. Set up context in your middleware
 * import { runWithLedgerContext, createLedgerContext } from '@rafters/ledger/context';
 *
 * app.use(async (c, next) => {
 *   const context = createLedgerContext({
 *     userId: c.get('user')?.id,
 *     ip: c.req.header('x-forwarded-for'),
 *     userAgent: c.req.header('user-agent'),
 *     endpoint: `${c.req.method} ${c.req.path}`,
 *   });
 *   return runWithLedgerContext(context, next);
 * });
 *
 * // 4. Use soft-delete in queries
 * import { notDeleted, softDeleteValues } from '@rafters/ledger/soft-delete';
 *
 * const activeUsers = await db.select().from(users).where(notDeleted(users));
 * ```
 */

// Core (ORM-agnostic)
export * from "./core/index.js";

// Drizzle adapter
export * from "./drizzle/index.js";

// Better Auth Plugin
export {
  createDeleteAuditCallback,
  createSoftDeleteCallback,
  isSoftDeletePerformed,
  type LedgerAuditEntry,
  type LedgerPluginConfig,
  ledgerPlugin,
  type SoftDeleteCallbackOptions,
  SoftDeletePerformedError,
} from "./better-auth.js";
