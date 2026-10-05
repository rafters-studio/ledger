/**
 * Ledger Better Auth Plugin
 *
 * Audit logging and user soft delete for better-auth 1.7+, wired through
 * databaseHooks. No ORM handle: the plugin writes through better-auth's
 * own adapter, so it works with any better-auth database adapter.
 *
 * @example
 * ```typescript
 * import { betterAuth } from 'better-auth';
 * import { ledgerPlugin } from '@rafters/ledger/better-auth';
 *
 * export const auth = betterAuth({
 *   database: drizzleAdapter(db, { provider: 'sqlite' }),
 *   user: {
 *     additionalFields: {
 *       deletedAt: { type: 'date', required: false, input: false },
 *       deletedBy: { type: 'string', required: false, input: false },
 *     },
 *     deleteUser: { enabled: true },
 *   },
 *   plugins: [
 *     ledgerPlugin({
 *       softDeleteUser: true,
 *       writeAuditEntry: async (entry) => {
 *         await db.insert(auditLog).values({ ...entry, id: uuidv7() });
 *       },
 *     }),
 *   ],
 * });
 * ```
 */

import type { AuthContext, BetterAuthPlugin, User } from "better-auth";
import { getLedgerContext } from "./core/context.js";
import type { LedgerContext } from "./core/types.js";
import { softDeleteValues } from "./core/soft-delete.js";
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
   * Soft-delete the user row instead of deleting it.
   *
   * Registers databaseHooks.user.delete.before: it sets deletedAt (and
   * deletedBy when the user schema declares it) through better-auth's
   * adapter, writes a SOFT_DELETE audit entry, and returns false so the
   * row delete is skipped. Every path through
   * internalAdapter.deleteUser soft-deletes: self-service deleteUser,
   * the email-token callback, and admin removeUser. The route still
   * revokes sessions, clears the cookie, and answers success.
   *
   * The user schema must declare deletedAt (user.additionalFields, with
   * input: false); without it the plugin throws at init.
   *
   * better-auth deletes the user's session and account rows BEFORE the
   * user hook runs, so credentials and OAuth links are hard-deleted. The
   * user row survives; sign-in must still be gated on deletedAt (see
   * docs/better-auth.mdx).
   */
  softDeleteUser?: boolean;
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
 * - Optional user soft delete (softDeleteUser) via databaseHooks.user.delete.before
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
 * @param config - Plugin configuration
 * @returns BetterAuthPlugin instance
 *
 * @example
 * ```typescript
 * import { ledgerPlugin } from '@rafters/ledger/better-auth';
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
  const softDeleteUser = config?.softDeleteUser === true;
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

  /**
   * The user delete.before hook for softDeleteUser. Writes through the
   * adapter directly, not internalAdapter.updateUser, so no update hooks
   * fire (no stray UPDATE entry) and no session refresh runs on a user
   * whose sessions are being revoked. Returning false skips the row
   * delete; the route goes on to revoke sessions and answer success.
   */
  function softDeleteUserHook(ctx: AuthContext) {
    const fields = ctx.tables.user?.fields ?? {};
    if (!("deletedAt" in fields)) {
      throw new Error(
        "[ledger] softDeleteUser requires a deletedAt field on the better-auth user schema: declare it in user.additionalFields with input: false",
      );
    }
    const hasDeletedBy = "deletedBy" in fields;

    return async (user: User & Record<string, unknown>): Promise<false> => {
      const values = softDeleteValues(null);
      await ctx.adapter.update({
        model: "user",
        where: [{ field: "id", value: user.id }],
        update: {
          deletedAt: values.deletedAt,
          ...(hasDeletedBy ? { deletedBy: values.deletedBy } : {}),
        },
      });
      await audit({
        tableName: "user",
        recordId: user.id,
        action: "SOFT_DELETE",
        oldData: user,
        newData: { ...user, ...values },
        // Self-service deletion is the common flow, so the target is the
        // fallback actor; an authenticated context (admin) wins.
        userId: resolveActor(user.id),
      });
      return false;
    };
  }

  return {
    id: "ledger",
    init: (ctx) => {
      if (softDeleteUser) {
        databaseHooks["user"] = {
          ...databaseHooks["user"],
          delete: { before: softDeleteUserHook(ctx) },
        };
      }
      return { options: { databaseHooks } };
    },
  };
}

/**
 * Creates a simple audit-only callback for afterDelete.
 *
 * Logs the delete without preventing it (hard delete with audit trail).
 * Do not combine with softDeleteUser: afterDelete still runs after a
 * soft delete and would record a DELETE that did not happen.
 *
 * @param writeAuditEntry - Callback to write audit entry
 * @returns A callback function for afterDelete
 *
 * @example
 * ```typescript
 * import { createDeleteAuditCallback } from '@rafters/ledger/better-auth';
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
