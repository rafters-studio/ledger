/**
 * Drizzle Ledger Audited Database
 *
 * Wraps a Drizzle database instance (without mutating it) so that
 * delete() calls on the tables named in softDeleteTables are converted
 * to soft-delete. The allowlist is required: there is no mode that
 * guesses from a deletedAt column, because a guess that misses a table
 * hard-deletes it silently. Transaction callbacks receive an equally
 * wrapped tx, so deletes inside transactions get the same conversion.
 *
 * Scope and honesty notes:
 * - The wrapper converts statements BUILT THROUGH IT. Statements built
 *   on the original unwrapped instance (including ones passed to
 *   db.batch) are not converted -- build them via the wrapped instance.
 * - `await db.delete(t)` with no .where() follows Drizzle's delete-all
 *   semantics and becomes soft-delete-all (UPDATE without WHERE). It
 *   executes; it does not silently no-op.
 * - Soft-delete audit entries (when `writeAuditEntry` is configured)
 *   are statement-level: one entry per executed soft-delete statement,
 *   with recordId "unknown" -- the wrapper does not know affected row
 *   ids without a returning() round-trip.
 */

import { createAuditEntry } from "../core/audit.js";
import { getLedgerContext } from "../core/context.js";
import {
  AuditTableDeleteError,
  MissingSoftDeleteColumnError,
  MissingSoftDeleteTablesError,
  UnresolvedSoftDeleteTableError,
} from "../core/errors.js";
import { softDeleteValues } from "../core/soft-delete.js";
import type { AuditLogEntry } from "../core/types.js";

/**
 * Configuration for createAuditedDb.
 */
export interface AuditedDbConfig {
  /** Tables to exclude from soft-delete (will hard delete) */
  hardDeleteTables?: string[];
  /** Custom soft-delete values factory */
  softDeleteValuesFactory?: (deletedBy?: string | null) => {
    deletedAt: Date;
    deletedBy: string | null;
  };
  /**
   * Required allowlist of soft-delete tables (by drizzle table name).
   * A delete on a listed table converts to soft-delete; a listed table
   * without the deletedAt property THROWS MissingSoftDeleteColumnError
   * instead of silently hard-deleting; unlisted tables hard-delete.
   * Pass [] to soft-delete nothing. A call without it fails type-check,
   * and an untyped caller that omits it gets MissingSoftDeleteTablesError
   * at the first delete.
   */
  softDeleteTables: string[];
  /**
   * Audit sink for soft-delete conversions. When set, each executed
   * soft-delete statement emits one SOFT_DELETE entry (statement-level,
   * recordId "unknown") so the trail distinguishes soft-deletes from
   * ordinary updates. Write failures are logged, never thrown.
   */
  writeAuditEntry?: (entry: AuditLogEntry) => Promise<void>;
  /**
   * Name of the audit log table (default: "audit_log"). Deletes on it
   * through this wrapper THROW -- the trail must not be wipeable via
   * ledger's own APIs. Pair with auditLogProtectSql(auditTableName)
   * from the dialect schema module for engine-level append-only
   * enforcement -- pass the SAME name to both, or the SQL protects a
   * table you never write to.
   */
  auditTableName?: string;
}

/**
 * Check if a Drizzle table has a specific column.
 *
 * @param table - The Drizzle table object
 * @param columnName - The column name to check for
 * @returns true if the table has the column
 */
export function hasColumn(table: unknown, columnName: string): boolean {
  if (!table || typeof table !== "object") {
    return false;
  }

  const col = (table as Record<string, unknown>)[columnName];
  if (!col || typeof col !== "object") {
    return false;
  }

  return "name" in col;
}

/**
 * Get the table name from a Drizzle table object.
 *
 * @param table - The Drizzle table object
 * @returns The table name or null
 */
export function getTableName(table: unknown): string | null {
  if (!table || typeof table !== "object") {
    return null;
  }

  const tableObj = table as Record<string, unknown>;

  const nameSymbol = Symbol.for("drizzle:Name");
  if (nameSymbol in tableObj) {
    return tableObj[nameSymbol] as string;
  }

  if ("_" in tableObj && typeof tableObj._ === "object" && tableObj._ !== null) {
    const meta = tableObj._ as Record<string, unknown>;
    if ("name" in meta && typeof meta.name === "string") {
      return meta.name;
    }
  }

  return null;
}

interface DeleteAndUpdateCapable {
  delete: (table: unknown) => unknown;
  update: (table: unknown) => { set: (values: Record<string, unknown>) => unknown };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Wrap a query builder so that the first successful execution -- via
 * direct await, .execute(), .run(), or any thenable chain stage
 * (.where(), .returning()) -- fires onExecuted exactly once. Chain
 * methods return wrapped builders so the observation survives chaining.
 */
function observeExecution<T extends object>(
  builder: T,
  onExecuted: () => void,
  register?: (proxy: object) => void,
): T {
  const observedThen = (
    target: object,
    thenFn: (f?: (r: unknown) => unknown, r?: (e: unknown) => unknown) => unknown,
    onFulfilled?: (result: unknown) => unknown,
    onRejected?: (error: unknown) => unknown,
  ) =>
    thenFn.call(
      target,
      (result: unknown) => {
        onExecuted();
        return onFulfilled ? onFulfilled(result) : result;
      },
      onRejected,
    );

  const proxy = new Proxy(builder, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if (prop === "then" && typeof value === "function") {
        return (
          onFulfilled?: (result: unknown) => unknown,
          onRejected?: (error: unknown) => unknown,
        ) =>
          observedThen(
            target,
            value as (f?: (r: unknown) => unknown, r?: (e: unknown) => unknown) => unknown,
            onFulfilled,
            onRejected,
          );
      }

      // catch must route through the OBSERVED then, not the generic
      // branch: Drizzle's QueryPromise implements catch as
      // this.then(undefined, onRejected), and the generic branch would
      // re-observe the promise catch returns -- which FULFILLS when the
      // handler swallows a rejection, firing a false SOFT_DELETE audit
      // entry for a statement that never executed.
      if (prop === "catch" && typeof value === "function") {
        const thenFn = Reflect.get(target, "then", receiver);
        if (typeof thenFn === "function") {
          return (onRejected?: (error: unknown) => unknown) =>
            observedThen(
              target,
              thenFn as (f?: (r: unknown) => unknown, r?: (e: unknown) => unknown) => unknown,
              undefined,
              onRejected,
            );
        }
      }

      if (typeof value !== "function") {
        return value;
      }

      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);

        if (isPromiseLike(result)) {
          // Thenable builders (where/returning chains) stay observable;
          // plain promises (execute/run) observe on fulfillment.
          if (typeof result === "object" && result !== null && !(result instanceof Promise)) {
            return observeExecution(result as object, onExecuted, register);
          }
          return (result as Promise<unknown>).then((r) => {
            onExecuted();
            return r;
          });
        }

        if (result !== null && typeof result === "object") {
          return observeExecution(result as object, onExecuted, register);
        }

        return result;
      };
    },
  }) as T;
  register?.(proxy as object);
  return proxy;
}

/**
 * Wraps a Drizzle database instance to automatically convert
 * delete() calls to soft-delete for the tables in softDeleteTables.
 *
 * Returns a wrapped instance; the original `db` reference is NOT
 * mutated and keeps original hard-delete behavior.
 *
 * @param db - The Drizzle database instance
 * @param config - Configuration; softDeleteTables is required
 * @returns A wrapped database instance (same type as input)
 *
 * @example
 * ```typescript
 * import { drizzle } from 'drizzle-orm/d1';
 * import { createAuditedDb } from '@rafters/ledger/drizzle';
 *
 * const baseDb = drizzle(env.DB);
 * export const db = createAuditedDb(baseDb, {
 *   softDeleteTables: ['users', 'messages'],
 * });
 *
 * // db.delete(users) executes: UPDATE users SET deleted_at = ?, deleted_by = ?
 * await db.delete(users).where(eq(users.id, userId));
 *
 * // Deletes inside transactions are converted too
 * await db.transaction(async (tx) => {
 *   await tx.delete(users).where(eq(users.id, userId));
 * });
 * ```
 */
export function createAuditedDb<T extends object>(db: T, config: AuditedDbConfig): T {
  const softDeleteFactory = config?.softDeleteValuesFactory ?? softDeleteValues;
  // Statement proxies (and every proxy derived from them by chaining)
  // mapped to their once-guarded audit trigger, so the batch path can
  // fire audits for member statements that never flow through then().
  const statementAudits = new WeakMap<object, () => void>();

  const auditTableName = config?.auditTableName ?? "audit_log";

  const interceptDelete = (table: unknown): unknown => {
    // Untyped callers can still omit the allowlist; refuse rather than
    // guess which tables soft-delete.
    if (!Array.isArray(config?.softDeleteTables)) {
      throw new MissingSoftDeleteTablesError();
    }

    const target = db as unknown as DeleteAndUpdateCapable;
    const tableName = getTableName(table);

    // The audit trail must not be wipeable through ledger's own wrapper.
    if (tableName === auditTableName) {
      throw new AuditTableDeleteError(auditTableName);
    }

    if (tableName && config?.hardDeleteTables?.includes(tableName)) {
      return target.delete(table);
    }

    // Loud by contract: an unresolvable table name cannot be checked
    // against the allowlist, so it throws instead of silently
    // hard-deleting.
    if (!tableName) {
      throw new UnresolvedSoftDeleteTableError();
    }
    if (!config.softDeleteTables.includes(tableName)) {
      return target.delete(table);
    }
    if (!hasColumn(table, "deletedAt")) {
      throw new MissingSoftDeleteColumnError(tableName);
    }

    const context = getLedgerContext();
    const deleteValues = softDeleteFactory(context?.userId);
    const builder = target.update(table).set(deleteValues);

    const writeAuditEntry = config?.writeAuditEntry;
    if (!writeAuditEntry || builder === null || typeof builder !== "object") {
      return builder;
    }

    let audited = false;
    const fireAudit = () => {
      if (audited) return;
      audited = true;
      const entry = createAuditEntry({
        tableName,
        recordId: "unknown",
        action: "SOFT_DELETE",
        oldData: null,
        newData: { ...deleteValues },
      });
      writeAuditEntry(entry).catch((err) => {
        console.error("[ledger] Failed to write soft-delete audit entry:", err);
      });
    };

    return observeExecution(builder as object, fireAudit, (proxy) => {
      statementAudits.set(proxy, fireAudit);
    });
  };

  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "delete") {
        return interceptDelete;
      }

      if (prop === "batch") {
        const original = Reflect.get(target, prop, receiver);
        if (typeof original !== "function") {
          return original;
        }
        // Drizzle's batch reaches into each statement via _prepare()
        // and never touches then()/execute(), so execution observation
        // cannot fire there. Observe at the batch boundary instead:
        // when the batch fulfills, fire the audit trigger of every
        // member statement built through this wrapper.
        return (statements: unknown[], ...args: unknown[]) => {
          const result = (original as (...a: unknown[]) => unknown).call(
            target,
            statements,
            ...args,
          );
          return Promise.resolve(result).then((batchResult) => {
            if (Array.isArray(statements)) {
              for (const statement of statements) {
                if (statement !== null && typeof statement === "object") {
                  statementAudits.get(statement)?.();
                }
              }
            }
            return batchResult;
          });
        };
      }

      if (prop === "transaction") {
        const original = Reflect.get(target, prop, receiver);
        if (typeof original !== "function") {
          return original;
        }
        return (callback: (tx: object, ...rest: unknown[]) => unknown, ...args: unknown[]) =>
          (original as (...a: unknown[]) => unknown).call(
            target,
            (tx: object, ...txArgs: unknown[]) => callback(createAuditedDb(tx, config), ...txArgs),
            ...args,
          );
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return (value as (...a: unknown[]) => unknown).bind(target);
      }
      return value;
    },
  });
}
