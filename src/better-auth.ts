/**
 * Drizzle Ledger Better Auth Plugin
 *
 * Integrates audit logging with better-auth via databaseHooks.
 *
 * For soft-delete functionality, use createSoftDeleteCallback with
 * the user.deleteUser.beforeDelete option.
 *
 * @example
 * ```typescript
 * import { betterAuth } from 'better-auth';
 * import { ledgerPlugin, createSoftDeleteCallback } from 'drizzle-ledger/better-auth-plugin';
 * import { eq } from 'drizzle-orm';
 *
 * export const auth = betterAuth({
 *   database: drizzle(env.DB),
 *   user: {
 *     deleteUser: {
 *       enabled: true,
 *       // Use createSoftDeleteCallback for actual soft-delete behavior
 *       beforeDelete: createSoftDeleteCallback({
 *         db,
 *         userTable: users,
 *         whereUserId: (userId) => eq(users.id, userId),
 *       }),
 *     },
 *   },
 *   plugins: [
 *     // Plugin provides audit logging for create/update via databaseHooks
 *     ledgerPlugin({
 *       writeAuditEntry: async (entry) => {
 *         await db.insert(auditLog).values({ ...entry, id: uuidv7() });
 *       },
 *     }),
 *   ],
 * });
 * ```
 */

import type { BetterAuthPlugin, User } from "better-auth";
import { softDeleteValues } from "./soft-delete/index.js";

/**
 * Audit entry passed to the writeAuditEntry callback.
 */
export interface LedgerAuditEntry {
  /** The table name (user, account, session, verification) */
  tableName: string;
  /** The record ID */
  recordId: string;
  /** The action performed (INSERT, UPDATE, SOFT_DELETE for soft-deletes, DELETE for hard deletes) */
  action: "INSERT" | "UPDATE" | "SOFT_DELETE" | "DELETE";
  /** The data before the operation (for UPDATE/SOFT_DELETE/DELETE) */
  oldData: Record<string, unknown> | null;
  /** The data after the operation (for INSERT/UPDATE) */
  newData: Record<string, unknown> | null;
  /** The user ID performing the action (if available) */
  userId: string | null;
}

/**
 * Configuration for the ledger plugin.
 */
export interface LedgerPluginConfig {
  /**
   * Tables to log delete audit entries for.
   * Currently only 'user' is supported (better-auth only exposes user deleteUser hooks).
   * Note: This only logs audit entries; to actually perform soft-delete,
   * use createSoftDeleteCallback with user.deleteUser.beforeDelete.
   */
  softDeleteTables?: "user"[];
  /**
   * Callback to write an audit entry.
   * If not provided, audit logging is disabled.
   */
  writeAuditEntry?: (entry: LedgerAuditEntry) => Promise<void>;
  /**
   * Tables to audit. Defaults to ['user', 'account'].
   * Session and verification are excluded by default due to high volume.
   */
  auditTables?: ("user" | "account" | "session" | "verification")[];
}

// Helper to safely log errors without blocking auth operations
function safeLog(message: string, error?: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[drizzle-ledger] ${message}`, error ?? "");
}

// Type for better-auth user with id
type UserWithId = { id: string } & Record<string, unknown>;

/**
 * Better Auth plugin for audit logging.
 *
 * Features:
 * - Audit logging for user and account create/update operations via databaseHooks
 * - Optional delete audit logging when softDeleteTables includes 'user'
 *
 * NOTE: This plugin only provides audit logging. For actual soft-delete behavior
 * (updating deletedAt instead of hard deleting), use createSoftDeleteCallback
 * with the user.deleteUser.beforeDelete option.
 *
 * @param config - Plugin configuration
 * @returns BetterAuthPlugin instance
 *
 * @example
 * ```typescript
 * import { ledgerPlugin } from 'drizzle-ledger/better-auth-plugin';
 *
 * export const auth = betterAuth({
 *   plugins: [
 *     ledgerPlugin({
 *       writeAuditEntry: async (entry) => {
 *         await db.insert(auditLog).values({
 *           id: uuidv7(),
 *           ...entry,
 *           createdAt: new Date(),
 *         });
 *       },
 *     }),
 *   ],
 * });
 * ```
 */
export function ledgerPlugin(config?: LedgerPluginConfig): BetterAuthPlugin {
  const auditTables = config?.auditTables ?? ["user", "account"];
  const softDeleteTables = config?.softDeleteTables ?? [];
  const writeAuditEntry = config?.writeAuditEntry;

  // Helper to safely write audit entry
  async function audit(entry: LedgerAuditEntry): Promise<void> {
    if (!writeAuditEntry) return;
    try {
      await writeAuditEntry(entry);
    } catch (error) {
      safeLog("Failed to write audit entry", error);
    }
  }

  // Build databaseHooks based on audited tables
  // biome-ignore lint/suspicious/noExplicitAny: Required for better-auth databaseHooks typing
  const databaseHooks: Record<string, any> = {};

  for (const table of auditTables) {
    databaseHooks[table] = {
      create: {
        after: async (data: UserWithId) => {
          await audit({
            tableName: table,
            recordId: data.id,
            action: "INSERT",
            oldData: null,
            newData: data as Record<string, unknown>,
            userId: table === "user" ? data.id : null,
          });
        },
      },
      update: {
        after: async (data: UserWithId) => {
          await audit({
            tableName: table,
            recordId: data.id,
            action: "UPDATE",
            oldData: null, // We don't have access to old data in after hook
            newData: data as Record<string, unknown>,
            userId: table === "user" ? data.id : null,
          });
        },
      },
    };
  }

  // Add user delete audit logging if configured
  // Note: better-auth's deleteUser hooks are NOT part of databaseHooks.
  // They must be configured separately in user.deleteUser config.
  // This plugin ONLY logs a SOFT_DELETE audit entry; it does NOT perform the
  // actual soft-delete. To implement soft-delete behavior (e.g. updating
  // a deletedAt column), configure your own user.deleteUser.beforeDelete
  // callback, for example using createSoftDeleteCallback.
  const userDeleteHooks = softDeleteTables.includes("user")
    ? {
        beforeDelete: async (user: User) => {
          // Log the soft-delete intent
          await audit({
            tableName: "user",
            recordId: user.id,
            action: "SOFT_DELETE",
            oldData: user as unknown as Record<string, unknown>,
            newData: null,
            userId: user.id,
          });
        },
      }
    : undefined;

  return {
    id: "drizzle-ledger",
    init: () => {
      return {
        options: {
          databaseHooks,
          ...(userDeleteHooks
            ? {
                user: {
                  deleteUser: userDeleteHooks,
                },
              }
            : {}),
        },
      };
    },
  };
}

/**
 * Options for the soft-delete callback.
 */
export interface SoftDeleteCallbackOptions {
  /**
   * Drizzle database instance with update capability.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Required for Drizzle type compatibility
  db: { update: (table: any) => any };
  /**
   * The user table with deletedAt column.
   * Must have 'id' and 'deletedAt' columns.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Required for Drizzle table type compatibility
  userTable: { id: any; deletedAt: any; deletedBy?: any };
  /**
   * Function to build a WHERE clause for the user ID.
   * Example: (userId) => eq(userTable.id, userId)
   */
  // biome-ignore lint/suspicious/noExplicitAny: Required for Drizzle SQL type compatibility
  whereUserId: (userId: string) => any;
  /**
   * Callback to write audit entry (optional).
   */
  writeAuditEntry?: (entry: LedgerAuditEntry) => Promise<void>;
}

/**
 * Creates a beforeDelete callback that performs soft-delete instead of hard delete.
 *
 * This callback:
 * 1. Performs a soft-delete UPDATE on the user record
 * 2. Logs an audit entry (if writeAuditEntry is provided)
 * 3. Throws to prevent the actual hard delete
 *
 * IMPORTANT: The throw prevents the hard delete from happening.
 * Your client code should catch this and treat it as success.
 *
 * @param options - Configuration options
 * @returns A beforeDelete callback function
 *
 * @example
 * ```typescript
 * import { createSoftDeleteCallback } from 'drizzle-ledger/better-auth-plugin';
 * import { eq } from 'drizzle-orm';
 *
 * export const auth = betterAuth({
 *   user: {
 *     deleteUser: {
 *       enabled: true,
 *       beforeDelete: createSoftDeleteCallback({
 *         db,
 *         userTable: users,
 *         whereUserId: (userId) => eq(users.id, userId),
 *         writeAuditEntry: async (entry) => {
 *           await db.insert(auditLog).values({ ...entry, id: uuidv7() });
 *         },
 *       }),
 *     },
 *   },
 * });
 * ```
 */
export function createSoftDeleteCallback(
  options: SoftDeleteCallbackOptions,
): (user: User, request?: Request) => Promise<void> {
  const { db, userTable, whereUserId, writeAuditEntry } = options;

  return async (user: User, _request?: Request): Promise<void> => {
    // Perform soft-delete
    const deleteVals = softDeleteValues(null);

    // biome-ignore lint/suspicious/noExplicitAny: Required for Drizzle ORM dynamic table operations
    await (db.update(userTable) as any)
      .set({
        deletedAt: deleteVals.deletedAt,
        ...(userTable.deletedBy !== undefined ? { deletedBy: deleteVals.deletedBy } : {}),
      })
      .where(whereUserId(user.id));

    // Log to audit
    if (writeAuditEntry) {
      try {
        await writeAuditEntry({
          tableName: "user",
          recordId: user.id,
          action: "SOFT_DELETE",
          oldData: user as unknown as Record<string, unknown>,
          newData: { ...user, ...deleteVals } as unknown as Record<string, unknown>,
          userId: user.id,
        });
      } catch (error) {
        safeLog("Failed to write audit entry for soft-delete", error);
      }
    }

    // Throw to prevent the hard delete from happening
    // This is the recommended pattern for better-auth's beforeDelete
    // Use isSoftDeletePerformed() to check for this error type
    throw new SoftDeletePerformedError(user.id);
  };
}

/**
 * Creates a simple audit-only callback for afterDelete.
 *
 * Unlike createSoftDeleteCallback, this just logs the delete without
 * preventing it (useful for hard delete with audit trail).
 *
 * @param writeAuditEntry - Callback to write audit entry
 * @returns A callback function for afterDelete
 *
 * @example
 * ```typescript
 * import { createDeleteAuditCallback } from 'drizzle-ledger/better-auth-plugin';
 *
 * export const auth = betterAuth({
 *   user: {
 *     deleteUser: {
 *       enabled: true,
 *       afterDelete: createDeleteAuditCallback(async (entry) => {
 *         await db.insert(auditLog).values({ ...entry, id: uuidv7() });
 *       }),
 *     },
 *   },
 * });
 * ```
 */
export function createDeleteAuditCallback(
  writeAuditEntry: (entry: LedgerAuditEntry) => Promise<void>,
): (user: User, request?: Request) => Promise<void> {
  return async (user: User, _request?: Request): Promise<void> => {
    try {
      await writeAuditEntry({
        tableName: "user",
        recordId: user.id,
        action: "DELETE", // Hard delete action (user was permanently deleted)
        oldData: user as unknown as Record<string, unknown>,
        newData: null,
        userId: user.id,
      });
    } catch (error) {
      safeLog("Failed to write audit entry for delete", error);
    }
  };
}

/**
 * Error thrown when soft-delete is performed successfully.
 * Check for this error type to handle soft-delete success cases.
 */
export class SoftDeletePerformedError extends Error {
  readonly code = "SOFT_DELETE_PERFORMED" as const;
  readonly softDeleted = true as const;
  readonly userId: string;

  constructor(userId: string) {
    super("User soft-deleted successfully");
    this.name = "SoftDeletePerformedError";
    this.userId = userId;
  }
}

/**
 * Check if an error is a soft-delete success error.
 *
 * @param error - The error to check
 * @returns true if this is a soft-delete success
 *
 * @example
 * ```typescript
 * try {
 *   await auth.api.deleteUser({ userId });
 * } catch (error) {
 *   if (isSoftDeletePerformed(error)) {
 *     // Success! User was soft-deleted
 *     return { success: true };
 *   }
 *   throw error;
 * }
 * ```
 */
export function isSoftDeletePerformed(error: unknown): error is SoftDeletePerformedError {
  if (error instanceof SoftDeletePerformedError) return true;
  if (error instanceof Error) {
    return (
      "code" in error &&
      (error as Error & { code?: string }).code === "SOFT_DELETE_PERFORMED" &&
      "softDeleted" in error &&
      (error as Error & { softDeleted?: boolean }).softDeleted === true
    );
  }
  return false;
}
