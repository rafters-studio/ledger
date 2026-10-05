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
 *   carry one recordId per affected row. On SQLite and PostgreSQL the
 *   UPDATE runs with RETURNING the primary key, so a statement without
 *   a caller returning() resolves to the affected keys instead of the
 *   driver's run result. On MySQL the keys are selected before the
 *   UPDATE, which is not atomic. run() executes through all() and
 *   resolves to the rows, as an await does; values() reads the keys
 *   from its row arrays.
 */

import { createAuditEntry } from "../core/audit.js";
import { getLedgerContext } from "../core/context.js";
import {
  AuditTableDeleteError,
  MissingPrimaryKeyError,
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
   * soft-delete statement emits one SOFT_DELETE entry per affected row,
   * with the row's primary key as recordId (a composite key as a JSON
   * array); a statement that matches nothing emits none. Tables audited
   * this way need a primary key (MissingPrimaryKeyError otherwise).
   * Write failures are logged, never thrown.
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

type Row = Record<PropertyKey, unknown>;

function isRow(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Prefix of the selection keys the wrapper adds to a caller's own returning(). */
const PK_ALIAS_PREFIX = "__ledger_pk_";

const COLUMNS_SYMBOL = Symbol.for("drizzle:Columns");
const EXTRA_CONFIG_BUILDER_SYMBOL = Symbol.for("drizzle:ExtraConfigBuilder");
const ENTITY_KIND_SYMBOL = Symbol.for("drizzle:entityKind");

/**
 * The table's primary key as [property key, column] pairs in key order:
 * a single `.primaryKey()` column, else the columns of a composite
 * `primaryKey({ columns })` declared in the table's extra config.
 * Empty when the table declares no primary key.
 */
function getPrimaryKeyColumns(table: unknown): [string, unknown][] {
  if (!isRow(table)) return [];
  const columns = table[COLUMNS_SYMBOL];
  if (!isRow(columns)) return [];
  const entries = Object.entries(columns);

  const single = entries.filter(([, column]) => isRow(column) && column.primary === true);
  if (single.length > 0) return single;

  const extraConfigBuilder = table[EXTRA_CONFIG_BUILDER_SYMBOL];
  if (typeof extraConfigBuilder !== "function") return [];
  const extraConfig: unknown = extraConfigBuilder(columns);
  const builders = Array.isArray(extraConfig)
    ? extraConfig.flat(1)
    : isRow(extraConfig)
      ? Object.values(extraConfig)
      : [];
  for (const builder of builders) {
    if (!isRow(builder) || typeof builder.build !== "function") continue;
    const kind: unknown = (builder.constructor as unknown as Row | undefined)?.[ENTITY_KIND_SYMBOL];
    if (typeof kind !== "string" || !kind.endsWith("PrimaryKeyBuilder")) continue;
    const built: unknown = builder.build(table);
    if (!isRow(built) || !Array.isArray(built.columns)) continue;
    const keyColumns = built.columns;
    return keyColumns.flatMap((keyColumn: unknown) => {
      const entry = entries.find(([, column]) => column === keyColumn);
      return entry ? [entry] : [];
    });
  }
  return [];
}

/** One record id per row; a composite key serializes as a JSON array, as the Kysely plugin does. */
function recordIdOf(values: readonly unknown[]): string {
  if (values.length === 1) return String(values[0]);
  return JSON.stringify(values.map((value) => String(value)));
}

/**
 * The affected-row count a driver's run result reports (better-sqlite3
 * `changes`, libsql `rowsAffected`, node-postgres `rowCount`, D1
 * `meta.changes`), or undefined when it reports none.
 */
function affectedRowCount(result: unknown): number | undefined {
  if (!isRow(result)) return undefined;
  const meta = result.meta;
  const candidates = [
    result.changes,
    result.rowsAffected,
    result.rowCount,
    isRow(meta) ? meta.changes : undefined,
  ];
  const count = candidates.find((value) => typeof value === "number");
  return typeof count === "number" ? count : undefined;
}

/** Execution methods on Drizzle builders and prepared queries. */
const EXECUTION_METHODS = new Set(["execute", "all", "run", "values"]);

interface ExecutionHooks {
  /**
   * Receives each successful execution's result (plus whatever `before`
   * produced) and returns the value the caller sees.
   */
  settle: (result: unknown, before: unknown) => unknown;
  /** Runs ahead of every execution; its value is handed to settle. */
  before?: () => Promise<unknown>;
  /** Rewrites the caller's returning() selection. */
  returning?: (fields: unknown) => unknown;
}

/**
 * Wrap a query builder so that every successful execution -- via direct
 * await, .execute(), .all(), .get(), .run(), .values(), or any chain
 * stage (.where(), .returning(), .prepare()) -- passes its result
 * through hooks.settle. Chain methods return wrapped builders so the
 * observation survives chaining.
 */
function observeExecution<T extends object>(
  builder: T,
  hooks: ExecutionHooks,
  register?: (proxy: object) => void,
): T {
  const { settle, before } = hooks;

  // Run an execution, with `before` ahead of it when set, and settle its
  // result. A sync driver's result settles synchronously.
  const run = (execute: () => unknown): unknown => {
    if (before) {
      return before().then((pre) =>
        Promise.resolve(execute()).then((result) => settle(result, pre)),
      );
    }
    const result = execute();
    if (isPromiseLike(result)) {
      return Promise.resolve(result).then((r) => settle(r, undefined));
    }
    return settle(result, undefined);
  };

  const proxy = new Proxy(builder, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      // catch must route through the OBSERVED then, not a generic branch:
      // Drizzle's QueryPromise implements catch as
      // this.then(undefined, onRejected), and re-observing the promise
      // catch returns -- which FULFILLS when the handler swallows a
      // rejection -- would write a false SOFT_DELETE audit entry for a
      // statement that never executed.
      if ((prop === "then" || prop === "catch") && typeof value === "function") {
        const thenFn: unknown = prop === "then" ? value : Reflect.get(target, "then", receiver);
        if (typeof thenFn === "function") {
          const observedThen = (
            onFulfilled?: (result: unknown) => unknown,
            onRejected?: (error: unknown) => unknown,
          ) =>
            Promise.resolve(
              run(() => new Promise((resolve, reject) => thenFn.call(target, resolve, reject))),
            ).then(onFulfilled, onRejected);
          return prop === "then"
            ? observedThen
            : (onRejected?: (error: unknown) => unknown) => observedThen(undefined, onRejected);
        }
      }

      if (typeof value !== "function") {
        return value;
      }

      const method = value as (...a: unknown[]) => unknown;

      // get() returns only the first row and run() discards the rows,
      // so ids read from either would be wrong: execute through all().
      // get() hands the caller the first row; run() hands it the rows,
      // as an await does.
      if (prop === "get" || prop === "run") {
        const all: unknown = Reflect.get(target, "all", receiver);
        if (typeof all === "function") {
          return (...args: unknown[]) => {
            const rows = run(() => all.apply(target, args));
            if (prop === "run") return rows;
            const first = (r: unknown) => (Array.isArray(r) ? r[0] : r);
            return isPromiseLike(rows) ? Promise.resolve(rows).then(first) : first(rows);
          };
        }
      }

      if (typeof prop === "string" && EXECUTION_METHODS.has(prop)) {
        return (...args: unknown[]) => run(() => method.apply(target, args));
      }

      if (prop === "returning" && hooks.returning) {
        const rewrite = hooks.returning;
        return (fields?: unknown) =>
          observeExecution(method.call(target, rewrite(fields)) as object, hooks, register);
      }

      return (...args: unknown[]) => {
        const result = method.apply(target, args);
        if (
          result !== null &&
          typeof result === "object" &&
          !(result instanceof Promise) &&
          !Array.isArray(result)
        ) {
          return observeExecution(result as object, hooks, register);
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
  // mapped to their settle function, so the batch path can audit member
  // statements that never flow through then().
  const statementAudits = new WeakMap<object, (result: unknown) => unknown>();

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

    const keys = getPrimaryKeyColumns(table);
    if (keys.length === 0) {
      throw new MissingPrimaryKeyError(tableName);
    }

    // Called once per execution, and every execution writes: a prepared
    // statement run again or a builder awaited twice soft-deletes its
    // rows again. Settle is not re-entrant (Drizzle's then/execute run
    // on the unwrapped target), so one execution writes one entry set.
    const writeEntries = (recordIds: readonly string[]) => {
      for (const recordId of recordIds) {
        const entry = createAuditEntry({
          tableName,
          recordId,
          action: "SOFT_DELETE",
          oldData: null,
          newData: { ...deleteValues },
        });
        writeAuditEntry(entry).catch((err) => {
          console.error("[ledger] Failed to write soft-delete audit entry:", err);
        });
      }
    };

    // The key selection under reserved aliases, for merging into a
    // caller's own returning() and for the MySQL pre-select.
    const aliased: Row = Object.fromEntries(
      keys.map(([, column], i) => [`${PK_ALIAS_PREFIX}${i}`, column]),
    );
    const aliasKeys = Object.keys(aliased);

    const builderRow = builder as Row;
    if (typeof builderRow.returning !== "function") {
      // No UPDATE ... RETURNING (MySQL): select the matching keys first,
      // then run the update. Not atomic: a row that starts or stops
      // matching between the two statements is misreported.
      const source = target as unknown as {
        select: (fields: Row) => { from: (t: unknown) => { where: (w: unknown) => unknown } };
      };
      const before = async () => {
        const config = builderRow.config;
        const where = isRow(config) ? config.where : undefined;
        const rows: unknown = await source.select(aliased).from(table).where(where);
        return Array.isArray(rows) ? rows.filter(isRow) : [];
      };
      const settle = (result: unknown, selected: unknown) => {
        if (Array.isArray(selected)) {
          writeEntries(
            selected.filter(isRow).map((row) => recordIdOf(aliasKeys.map((key) => row[key]))),
          );
        }
        return result;
      };
      return observeExecution(builder as object, { settle, before }, (proxy) => {
        statementAudits.set(proxy, (result) => settle(result, undefined));
      });
    }

    // UPDATE ... RETURNING the key columns under their own property
    // names. A caller's returning() replaces the selection, so it is
    // rewritten to carry the key under reserved aliases, which settle
    // strips again before the caller sees the rows.
    let idKeys = keys.map(([key]) => key);
    let stripAliases = false;
    const returning = (fields: unknown) => {
      idKeys = aliasKeys;
      stripAliases = true;
      const base = isRow(fields) ? fields : isRow(table) ? table[COLUMNS_SYMBOL] : undefined;
      return { ...(isRow(base) ? base : {}), ...aliased };
    };

    // A rows array tells which rows changed: an empty one means nothing
    // matched, so nothing is written. values() returns each row as an
    // array in selection order, where the key columns come last (the
    // whole selection, or the aliases appended to a caller's own).
    // Any other result names no rows: it writes one statement-level
    // entry with recordId "unknown" unless the driver reports zero
    // affected rows.
    const settle = (result: unknown) => {
      if (Array.isArray(result) && result.every(Array.isArray)) {
        const keyStart = (row: unknown[]) => row.length - keys.length;
        writeEntries(result.map((row: unknown[]) => recordIdOf(row.slice(keyStart(row)))));
        if (!stripAliases) return result;
        return result.map((row: unknown[]) => row.slice(0, keyStart(row)));
      }
      if (!Array.isArray(result) || !result.every(isRow)) {
        if (affectedRowCount(result) !== 0) writeEntries(["unknown"]);
        return result;
      }
      writeEntries(result.map((row) => recordIdOf(idKeys.map((key) => row[key]))));
      if (!stripAliases) return result;
      return result.map((row) =>
        Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith(PK_ALIAS_PREFIX))),
      );
    };

    const withKeys = (builderRow.returning as (fields: Row) => object).call(
      builder,
      Object.fromEntries(keys),
    );
    return observeExecution(withKeys, { settle, returning }, (proxy) => {
      statementAudits.set(proxy, settle);
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
        // cannot fire there. Observe at the batch boundary instead: the
        // batch result is index-aligned with its statements, so each
        // member built through this wrapper settles its own result.
        return (statements: unknown[], ...args: unknown[]) => {
          const result = (original as (...a: unknown[]) => unknown).call(
            target,
            statements,
            ...args,
          );
          return Promise.resolve(result).then((batchResult) => {
            if (!Array.isArray(statements) || !Array.isArray(batchResult)) {
              return batchResult;
            }
            return batchResult.map((memberResult: unknown, i) => {
              const statement: unknown = statements[i];
              const settle =
                statement !== null && typeof statement === "object"
                  ? statementAudits.get(statement)
                  : undefined;
              return settle ? settle(memberResult) : memberResult;
            });
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
