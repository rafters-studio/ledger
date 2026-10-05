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
 * import { ledgerPlugin, createSoftDeleteCallback } from '@rafters/ledger/better-auth-plugin';
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
 *         revokeSessions: async (userId) => {
 *           // Feature-detect: better-auth split the internal session
 *           // API mid-1.6 (deleteUserSessions(userId) vs the pre-split
 *           // deleteSessions(userId)); on post-split versions a userId
 *           // passed to deleteSessions SILENTLY DELETES NOTHING. The
 *           // local type widening exists because the two better-auth
 *           // type generations disagree -- it keeps both branches
 *           // compiling on either version.
 *           const ctx = await auth.$context;
 *           const ia = ctx.internalAdapter as {
 *             deleteUserSessions?: (userId: string) => Promise<void>;
 *             deleteSessions: (value: string | string[]) => Promise<void>;
 *           };
 *           if (ia.deleteUserSessions) {
 *             await ia.deleteUserSessions(userId);
 *           } else {
 *             await ia.deleteSessions(userId);
 *           }
 *         },
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
import { getLedgerContext } from "./core/context.js";
import type { LedgerContext } from "./core/types.js";
import { softDeleteValues } from "./core/soft-delete.js";
import { SoftDeletePerformedError, isSoftDeletePerformed } from "./core/errors.js";
import { redactTableRow } from "./core/redact.js";

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
   * Tables to audit. Defaults to ['user'].
   *
   * WARNING: 'account' rows carry OAuth accessToken/refreshToken/idToken
   * and credential password hashes. Redaction strips those fields before
   * any audit write, but auditing 'account' remains opt-in -- enable it
   * only with an actual compliance need.
   * 'verification' rows carry OTP codes and reset tokens in the
   * 'value' column. Redaction strips that column by table rule, so
   * auditing verification is safe, but it stays opt-in. Session is
   * excluded by default due to high volume.
   */
  auditTables?: ("user" | "account" | "session" | "verification")[];
  /**
   * Additional key patterns to redact beyond DEFAULT_SECRET_PATTERNS
   * (token, secret, password, apikey, api_key, otp, code, hash, salt,
   * jwt, credential, privatekey, private_key, authorization, cookie;
   * case-insensitive substring match) and TABLE_SECRET_COLUMNS
   * (verification.value). Redaction itself cannot be disabled: if
   * redaction fails, the audit entry is NOT written.
   */
  redactPatterns?: readonly string[];
}

// Helper to safely log errors without blocking auth operations
function safeLog(message: string, error?: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[ledger] ${message}`, error ?? "");
}

/**
 * Redact secret material from an audit entry's payloads.
 * Applied on EVERY plugin audit path before the sink sees the entry --
 * better-auth rows (account especially) carry OAuth tokens and password
 * hashes, and an audit trail must never become a secrets store.
 */
function redactAuditEntry(
  entry: LedgerAuditEntry,
  extraPatterns?: readonly string[],
): LedgerAuditEntry {
  return {
    ...entry,
    oldData: redactTableRow(entry.tableName, entry.oldData, extraPatterns),
    newData: redactTableRow(entry.tableName, entry.newData, extraPatterns),
  };
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
 * ATTRIBUTION REQUIRES CONTEXT: entries attribute to the authenticated
 * principal from AsyncLocalStorage. Wrap request handling in
 * runWithLedgerContext or every actor is null (except self-signup):
 *
 * ```typescript
 * // Hono middleware, before the auth handler
 * app.use(async (c, next) => {
 *   return runWithLedgerContext(
 *     createLedgerContext({
 *       userId: c.get("user")?.id ?? null,
 *       endpoint: `${c.req.method} ${c.req.path}`,
 *     }),
 *     next,
 *   );
 * });
 * ```
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
 * import { ledgerPlugin } from '@rafters/ledger/better-auth-plugin';
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
  const auditTables = config?.auditTables ?? ["user"];
  const softDeleteTables = config?.softDeleteTables ?? [];
  const writeAuditEntry = config?.writeAuditEntry;
  const redactPatterns = config?.redactPatterns;

  // Helper to safely write audit entry. Redaction is fail-closed: an
  // entry that cannot be redacted is never written.
  async function audit(entry: LedgerAuditEntry): Promise<void> {
    if (!writeAuditEntry) return;
    let redacted: LedgerAuditEntry;
    try {
      redacted = redactAuditEntry(entry, redactPatterns);
    } catch (error) {
      safeLog("Redaction failed; audit entry NOT written", error);
      return;
    }
    try {
      await writeAuditEntry(redacted);
    } catch (error) {
      safeLog("Failed to write audit entry", error);
    }
  }

  /**
   * Resolve the acting principal for an audit entry.
   * The authenticated actor from ledger context (runWithLedgerContext
   * middleware) always wins; without context the actor is unknown --
   * NEVER default to the target row's id, which recorded an admin
   * banning a user as the user acting on themselves. The one exception
   * is user self-creation (signup), where the created user genuinely is
   * the actor and no context exists yet.
   */
  function resolveActor(fallback: string | null = null): string | null {
    return getLedgerContext()?.userId ?? fallback;
  }

  // Build databaseHooks based on audited tables
  // biome-ignore lint/suspicious/noExplicitAny: Required for better-auth databaseHooks typing
  const databaseHooks: Record<string, any> = {};

  // Pair update.before change sets with update.after results, keyed by
  // the request's LedgerContext object (per-table queue per context).
  // better-auth's after hook has no access to the previous row and the
  // before hook has no row id, so exact pairing is impossible from the
  // hook surface. Keying by context confines pairing to one request:
  // concurrent requests in the same isolate can never cross-pair, and
  // an abandoned capture (a failed or vetoed update) dies with its
  // context instead of desyncing the plugin forever. Within one
  // request the queue is FIFO -- multiple updates to the same table in
  // a single request pair in order, and a veto mid-request can still
  // offset later pairs in THAT request; the { changed } entry shape
  // keeps the provenance explicit rather than pretending to be a full
  // before-image. Without a ledger context no capture happens and
  // oldData stays null -- change-set capture, like attribution,
  // requires runWithLedgerContext.
  const pendingChangeSets = new WeakMap<LedgerContext, Record<string, Record<string, unknown>[]>>();

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
            // Self-signup: the created user is the actor when no
            // authenticated context exists (there is no session yet).
            userId: resolveActor(table === "user" ? data.id : null),
          });
        },
      },
      update: {
        before: async (data: Record<string, unknown>) => {
          const context = getLedgerContext();
          if (context) {
            const byTable = pendingChangeSets.get(context) ?? {};
            (byTable[table] ??= []).push({ ...data });
            pendingChangeSets.set(context, byTable);
          }
          // Return nothing: echoing { data } back would overwrite
          // mutations other before-hooks made -- better-auth merges
          // each hook's returned data onto the accumulator, and this
          // hook receives the ORIGINAL payload, not the accumulated
          // one. undefined skips the merge entirely.
        },
        after: async (data: UserWithId) => {
          const context = getLedgerContext();
          const changed = context
            ? (pendingChangeSets.get(context)?.[table]?.shift() ?? null)
            : null;
          await audit({
            tableName: table,
            recordId: data.id,
            action: "UPDATE",
            // Not a full before-image (better-auth does not expose the
            // previous row); { changed } is the incoming change set
            // captured by update.before within this request's context.
            oldData: changed ? { changed } : null,
            newData: data as Record<string, unknown>,
            userId: resolveActor(),
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
          // Log the soft-delete intent. Self-service deletion is the
          // common flow, so the target is the fallback actor; an
          // authenticated context (admin deleting a user) wins.
          await audit({
            tableName: "user",
            recordId: user.id,
            action: "SOFT_DELETE",
            oldData: user as unknown as Record<string, unknown>,
            newData: null,
            userId: resolveActor(user.id),
          });
        },
      }
    : undefined;

  return {
    id: "ledger",
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
   * Revoke ALL sessions for the user. REQUIRED.
   *
   * Soft-delete via beforeDelete aborts better-auth's own deleteUser
   * cleanup, so nothing else revokes sessions: without this, a
   * "deleted" user keeps every live session (cookie cache, KV-backed
   * secondaryStorage, session rows) until natural expiry. Wire it to
   * better-auth's INTERNAL adapter --
   * (await auth.$context).internalAdapter.deleteUserSessions(userId)
   * on current 1.6.x -- which also clears secondaryStorage (including
   * the active-sessions index). Version hazard: before better-auth
   * split the API mid-1.6, the call was deleteSessions(userId); on
   * post-split versions deleteSessions takes session-token ARRAYS and
   * a userId argument silently deletes nothing -- feature-detect
   * deleteUserSessions (see the example below). Do not use
   * auth.api.revokeUserSessions: it exists only with the admin()
   * plugin and is gated on an authenticated admin session, which the
   * self-service deleteUser flow does not have. Making deletion
   * incomplete should require deliberately writing a no-op, not
   * forgetting a field.
   */
  revokeSessions: (userId: string) => Promise<void>;
  /**
   * Callback to write audit entry (optional).
   */
  writeAuditEntry?: (entry: LedgerAuditEntry) => Promise<void>;
  /**
   * Additional key patterns to redact beyond DEFAULT_SECRET_PATTERNS.
   * Redaction itself cannot be disabled.
   */
  redactPatterns?: readonly string[];
}

/**
 * Creates a beforeDelete callback that performs soft-delete instead of hard delete.
 *
 * This callback, IN ORDER:
 * 1. Revokes all of the user's sessions (revokeSessions -- required).
 *    Revocation failure aborts the whole operation with the real error:
 *    the caller must see the deletion as failed, never as succeeded
 *    with live sessions left behind.
 * 2. Performs the soft-delete UPDATE on the user record
 * 3. Logs a redacted audit entry (if writeAuditEntry is provided)
 * 4. Throws SoftDeletePerformedError to prevent the actual hard delete
 *
 * IMPORTANT: The throw prevents the hard delete from happening.
 * Your client code should catch this and treat it as success.
 *
 * SOFT-DELETE IS NOT DELETION UNTIL SIGN-IN IS GATED. Aborting
 * better-auth's deleteUser also aborts its account/OAuth cleanup, and
 * better-auth session resolution knows nothing about deletedAt -- so
 * beyond session revocation you MUST gate authentication on deletedAt,
 * or an OAuth sign-in on the soft-deleted row silently resurrects the
 * account. Recipe: a user databaseHook (or session create hook) that
 * rejects when the resolved user has deletedAt set:
 *
 * ```typescript
 * import { APIError } from "better-auth/api";
 *
 * databaseHooks: {
 *   session: {
 *     create: {
 *       before: async (session) => {
 *         const [u] = await db.select().from(users)
 *           .where(eq(users.id, session.userId));
 *         if (u?.deletedAt) {
 *           throw new APIError("FORBIDDEN", { message: "Account deleted" });
 *         }
 *       },
 *     },
 *   },
 * },
 * ```
 *
 * @param options - Configuration options
 * @returns A beforeDelete callback function
 *
 * @example
 * ```typescript
 * import { createSoftDeleteCallback } from '@rafters/ledger/better-auth-plugin';
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
 *         revokeSessions: async (userId) => {
 *           // The internal adapter works in the self-service deleteUser
 *           // flow and clears secondaryStorage itself. Do NOT use
 *           // auth.api.revokeUserSessions -- that endpoint exists only
 *           // with the admin() plugin and requires an authenticated
 *           // ADMIN session, which the user deleting their own account
 *           // does not have.
 *           // VERSION NOTE: better-auth split the internal API mid-1.6.
 *           // Late 1.6.x has deleteUserSessions(userId); before the
 *           // split, deleteSessions accepted a userId directly -- and on
 *           // post-split versions deleteSessions(userId) SILENTLY
 *           // DELETES NOTHING (it now takes session-token arrays). The
 *           // local type widening keeps both branches compiling on
 *           // either version's shipped types.
 *           const ctx = await auth.$context;
 *           const ia = ctx.internalAdapter as {
 *             deleteUserSessions?: (userId: string) => Promise<void>;
 *             deleteSessions: (value: string | string[]) => Promise<void>;
 *           };
 *           if (ia.deleteUserSessions) {
 *             await ia.deleteUserSessions(userId);
 *           } else {
 *             await ia.deleteSessions(userId);
 *           }
 *         },
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
  const { db, userTable, whereUserId, revokeSessions, writeAuditEntry } = options;

  return async (user: User, _request?: Request): Promise<void> => {
    // Revoke sessions FIRST. If this throws, the real error propagates:
    // no soft-delete happens, no success is signaled, and the caller
    // sees the deletion as failed. A crash between revocation and the
    // UPDATE leaves sessions dead and the user intact -- a safe state
    // the user can retry from. The reverse order would leave a
    // "deleted" user with live sessions.
    await revokeSessions(user.id);

    // Perform soft-delete
    const deleteVals = softDeleteValues(null);

    // biome-ignore lint/suspicious/noExplicitAny: Required for Drizzle ORM dynamic table operations
    await (db.update(userTable) as any)
      .set({
        deletedAt: deleteVals.deletedAt,
        ...(userTable.deletedBy !== undefined ? { deletedBy: deleteVals.deletedBy } : {}),
      })
      .where(whereUserId(user.id));

    // Log to audit (redacted, fail-closed on redaction failure)
    if (writeAuditEntry) {
      let redacted: LedgerAuditEntry | null = null;
      try {
        redacted = redactAuditEntry(
          {
            tableName: "user",
            recordId: user.id,
            action: "SOFT_DELETE",
            oldData: user as unknown as Record<string, unknown>,
            newData: { ...user, ...deleteVals } as unknown as Record<string, unknown>,
            userId: user.id,
          },
          options.redactPatterns,
        );
      } catch (error) {
        safeLog("Redaction failed; soft-delete audit entry NOT written", error);
      }
      if (redacted) {
        try {
          await writeAuditEntry(redacted);
        } catch (error) {
          safeLog("Failed to write audit entry for soft-delete", error);
        }
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
 * import { createDeleteAuditCallback } from '@rafters/ledger/better-auth-plugin';
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
  redactPatterns?: readonly string[],
): (user: User, request?: Request) => Promise<void> {
  return async (user: User, _request?: Request): Promise<void> => {
    let redacted: LedgerAuditEntry | null = null;
    try {
      redacted = redactAuditEntry(
        {
          tableName: "user",
          recordId: user.id,
          action: "DELETE", // Hard delete action (user was permanently deleted)
          oldData: user as unknown as Record<string, unknown>,
          newData: null,
          userId: user.id,
        },
        redactPatterns,
      );
    } catch (error) {
      safeLog("Redaction failed; delete audit entry NOT written", error);
    }
    if (redacted) {
      try {
        await writeAuditEntry(redacted);
      } catch (error) {
        safeLog("Failed to write audit entry for delete", error);
      }
    }
  };
}

// Re-export error types from core for backwards compatibility
export { SoftDeletePerformedError, isSoftDeletePerformed } from "./core/errors.js";
