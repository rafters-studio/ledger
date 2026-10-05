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
   * Tables to audit. Defaults to ['user']. Each audited table gets an
   * INSERT entry on create, an UPDATE entry on update, and a DELETE entry
   * (oldData = the deleted row, redacted) on every hard delete.
   *
   * WARNING: 'account' rows carry OAuth accessToken/refreshToken/idToken
   * and credential password hashes. Redaction strips those fields before
   * any audit write, but auditing 'account' remains opt-in -- enable it
   * only with an actual compliance need.
   * 'verification' rows carry OTP codes and reset tokens in the
   * 'value' column. Redaction strips that column by table rule, so
   * auditing verification is safe, but it stays opt-in. Session is
   * excluded by default due to high volume: every sign-in, refresh,
   * sign-out, and revocation writes an entry once it is listed.
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
 * The part of better-auth's hook context (GenericEndpointContext, the
 * second argument of every databaseHook) the plugin reads. null or
 * undefined when the write runs outside an endpoint.
 */
type HookContext =
  | {
      context?: { session?: { user?: { id?: string } } | null };
    }
  | null
  | undefined;

/**
 * Resolve the acting principal for an audit entry, in order:
 *
 * 1. The hook context's session user (ctx.context.session.user.id).
 * 2. The ledger context's userId (runWithLedgerContext), for writes
 *    outside an endpoint or from an endpoint with no session.
 * 3. The fallback: the target row's own id, passed only for user
 *    self-signup and user deletion, where the target is the actor.
 *
 * Otherwise the actor is unknown (null) -- NEVER default to the target
 * row's id, which recorded an admin banning a user as the user acting
 * on themselves.
 *
 * Which hooks carry a session (read from better-auth 1.7.7 source;
 * db/with-hooks passes tryGetCurrentAuthEndpointContext() to every
 * create, update, and delete hook): ctx.context.session is set by
 * getSessionFromCtx, which the session middlewares (sessionMiddleware,
 * sensitiveSessionMiddleware, freshSessionMiddleware, the admin
 * plugin's adminMiddleware) and some route bodies call. So update and
 * delete hooks from an authenticated route carry it: updateUser,
 * admin updateUser/setRole/banUser, unlinkAccount, revokeSession(s),
 * deleteUser, and verify-email when the caller is signed in.
 * create.after on user during sign-up does not: sign-up and sign-in
 * run only formCsrfMiddleware and never read the session, and the new
 * session is created after the user. ctx is undefined when
 * internalAdapter is called outside an endpoint.
 */
function resolveActor(ctx: HookContext, fallback: string | null = null): string | null {
  return ctx?.context?.session?.user?.id ?? getLedgerContext()?.userId ?? fallback;
}

/**
 * Better Auth plugin for audit logging.
 *
 * Features:
 * - Audit logging for create, update, and delete on every table in
 *   auditTables via databaseHooks (INSERT, UPDATE, DELETE entries)
 * - Optional user soft delete (softDeleteUser) via databaseHooks.user.delete.before
 *
 * Attribution comes from the hook context better-auth passes every
 * databaseHook: the session user of the endpoint that caused the write.
 * No middleware is needed for it. runWithLedgerContext stays useful for
 * calls outside a better-auth endpoint (internalAdapter from a job, a
 * script) and as the actor when the endpoint has no session; see
 * resolveActor for the order.
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

  // Build databaseHooks based on audited tables
  // biome-ignore lint/suspicious/noExplicitAny: Required for better-auth databaseHooks typing
  const databaseHooks: Record<string, any> = {};

  // Pair update.before change sets with update.after results, keyed by
  // the request (per-table queue per request). better-auth's after hook
  // has no access to the previous row and the before hook has no row
  // id, so exact pairing is impossible from the hook surface. The key is
  // the hook context object -- better-auth hands the same endpoint
  // context to the before and after hooks of one update -- or, when the
  // update runs outside an endpoint, the request's LedgerContext.
  // Keying by request confines pairing to it: concurrent requests in
  // the same isolate can never cross-pair, and an abandoned capture (a
  // failed or vetoed update) dies with its request instead of desyncing
  // the plugin forever. Within one request the queue is FIFO --
  // multiple updates to the same table in a single request pair in
  // order, and a veto mid-request can still offset later pairs in THAT
  // request; the { changed } entry shape keeps the provenance explicit
  // rather than pretending to be a full before-image. With neither a
  // hook context nor a ledger context no capture happens and oldData
  // stays null.
  const pendingChangeSets = new WeakMap<object, Record<string, Record<string, unknown>[]>>();

  function changeSetKey(ctx: HookContext): object | null {
    return ctx ?? getLedgerContext();
  }

  for (const table of auditTables) {
    databaseHooks[table] = {
      create: {
        after: async (data: UserWithId, ctx: HookContext) => {
          await audit({
            tableName: table,
            recordId: data.id,
            action: "INSERT",
            oldData: null,
            newData: data as Record<string, unknown>,
            // Self-signup: the created user is the actor when no
            // authenticated context exists (there is no session yet).
            userId: resolveActor(ctx, table === "user" ? data.id : null),
          });
        },
      },
      update: {
        before: async (data: Record<string, unknown>, ctx: HookContext) => {
          const key = changeSetKey(ctx);
          if (key) {
            const byTable = pendingChangeSets.get(key) ?? {};
            (byTable[table] ??= []).push({ ...data });
            pendingChangeSets.set(key, byTable);
          }
          // Return nothing: echoing { data } back would overwrite
          // mutations other before-hooks made -- better-auth merges
          // each hook's returned data onto the accumulator, and this
          // hook receives the ORIGINAL payload, not the accumulated
          // one. undefined skips the merge entirely.
        },
        after: async (data: UserWithId, ctx: HookContext) => {
          const key = changeSetKey(ctx);
          const changed = key ? (pendingChangeSets.get(key)?.[table]?.shift() ?? null) : null;
          await audit({
            tableName: table,
            recordId: data.id,
            action: "UPDATE",
            // Not a full before-image (better-auth does not expose the
            // previous row); { changed } is the incoming change set
            // captured by update.before within this request.
            oldData: changed ? { changed } : null,
            newData: data as Record<string, unknown>,
            userId: resolveActor(ctx),
          });
        },
      },
      // delete.after, not delete.before: a before hook can be vetoed by a
      // later hook (or by softDeleteUser's own veto), and a vetoed delete
      // fires no after hook, so after records only deletes that ran.
      // better-auth 1.7 routes every delete through these hooks:
      // - deleteWithHooks (unlinkAccount, revokeSession, a hard user delete):
      //   one call, the row as read before the delete.
      // - deleteManyWithHooks (deleteUser's sessions and accounts,
      //   revokeSessions, sign-out of all sessions): one call PER ROW, each
      //   with that row from a findMany snapshot taken before the delete --
      //   never once with the where clause. A veto from any row's before
      //   hook aborts the whole batch.
      // - consumeOneWithHooks (verification tokens): one call with the row
      //   the atomic consume returned.
      // queueAfterTransactionHook defers the call past the transaction;
      // the hook context is captured before it, so the actor resolves.
      delete: {
        after: async (data: UserWithId, ctx: HookContext) => {
          await audit({
            tableName: table,
            recordId: data.id,
            action: "DELETE",
            oldData: data as Record<string, unknown>,
            newData: null,
            // Matches the soft-delete path: self-service deletion is the
            // common flow, so a deleted user is the fallback actor.
            userId: resolveActor(ctx, table === "user" ? data.id : null),
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

    return async (user: User & Record<string, unknown>, hookCtx: HookContext): Promise<false> => {
      // deletedBy is the actor a context names (the session user, else
      // the ledger context) and null when none does. The audit entry
      // falls back to the target for self-service, as every user delete
      // does; the column records only a known actor.
      const actor = resolveActor(hookCtx);
      const values = softDeleteValues(actor);
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
        userId: actor ?? user.id,
      });
      return false;
    };
  }

  return {
    id: "ledger",
    init: (ctx) => {
      if (!softDeleteUser) return { options: { databaseHooks } };
      // A fresh object per init: better-auth keeps the hooks by reference, so
      // mutating the shared one would point an earlier instance's hook at a
      // later instance's adapter when one plugin value serves several.
      return {
        options: {
          databaseHooks: {
            ...databaseHooks,
            user: {
              ...databaseHooks["user"],
              delete: { ...databaseHooks["user"]?.delete, before: softDeleteUserHook(ctx) },
            },
          },
        },
      };
    },
  };
}

/**
 * Creates a simple audit-only callback for afterDelete.
 *
 * @deprecated ledgerPlugin records a hard user delete itself through
 * databaseHooks.user.delete.after whenever 'user' is in auditTables (the
 * default). Using this callback alongside it writes two DELETE entries for
 * one delete. Kept only for setups that audit user deletes without the
 * plugin; it will be removed in a future major.
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
          // afterDelete receives no hook context, so the ledger context
          // is the only source of an actor other than the target, which
          // stands in for self-service.
          userId: resolveActor(null, user.id),
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
