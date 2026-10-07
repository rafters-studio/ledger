/**
 * Atomic audit for better-auth on Cloudflare D1.
 *
 * D1 has no interactive transactions: the only atomic unit is
 * D1Database.batch(), and a batch is a list of statements that must all be
 * formed before it runs. better-auth's adapters expose no batch, so this
 * path works one level down, on the D1 binding itself.
 *
 * ledgerD1(env.DB) wraps the binding the app hands to better-auth. Every
 * audited adapter write runs once in a "capture" scope: the wrapped binding
 * records the single SQL statement the adapter would have run, instead of
 * running it. The audit rows are then built as INSERT ... SELECT statements
 * that read the changed row from the table itself, and the change plus its
 * audit statements go to D1 as ONE batch(). The batch commits or rolls back
 * as a whole: a failed audit write undoes the change, a failed change leaves
 * no audit row.
 *
 * The audit row's JSON is built by SQLite from the stored columns, so
 * oldData is the row as it stood when the batch ran (not a read from an
 * earlier round trip) and newData is the row the batch left. Column values
 * are the stored ones (a boolean is 0 or 1, a date is its stored text).
 * Secret columns are decided by the same redaction the SQLite and Postgres
 * path uses and written as the literal "[REDACTED]", never selected.
 */

import type { AuthContext } from "better-auth";
import { uuidv7 } from "uuidv7";
import {
  type AtomicAction,
  type AtomicEnv,
  LEDGER_AUDIT_MODEL,
  LedgerAtomicAuditError,
  actorFor,
  idOf,
  split,
  ACTOR_KEY,
  SOFT_DELETE_KEY,
} from "./better-auth-atomic.js";

type Adapter = AuthContext["adapter"];
type Tx = Parameters<Parameters<Adapter["transaction"]>[0]>[0];
type Where = NonNullable<Parameters<Tx["findMany"]>[0]["where"]>;
type Row = Record<string, unknown>;

/** The part of a D1 prepared statement ledger uses. A D1PreparedStatement satisfies it. */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  all(): Promise<D1ResultLike>;
  run(): Promise<D1ResultLike>;
  first(): Promise<unknown>;
  raw(): Promise<unknown[]>;
}

/** The part of a D1 result ledger reads. */
export interface D1ResultLike {
  results?: unknown[];
  success: boolean;
  meta: { changes?: number; last_row_id?: number; [key: string]: unknown };
}

/** The part of a D1 database ledger uses. A D1Database satisfies it. */
export interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<D1ResultLike[]>;
  exec(query: string): Promise<unknown>;
}

const HANDLE_KEY: unique symbol = Symbol.for("@rafters/ledger.d1");
const STORAGE_KEY: unique symbol = Symbol.for("@rafters/ledger.d1-capture");

interface CaptureScope {
  statements: D1StatementLike[];
}

/** What the atomic path holds of a ledgerD1-wrapped binding. */
interface D1Handle {
  /** Run fn with writes captured, not executed; returns the statements fn tried to run. */
  capture(fn: () => Promise<unknown>): Promise<D1StatementLike[]>;
  /** The real binding's prepare(). */
  prepare(sql: string): D1StatementLike;
  /** The real binding's batch(). */
  batch(statements: D1StatementLike[]): Promise<D1ResultLike[]>;
}

type StorageHost = { [STORAGE_KEY]?: AsyncLocalStorage<CaptureScope> };

function captureStorage(): AsyncLocalStorage<CaptureScope> {
  if (typeof AsyncLocalStorage === "undefined") {
    throw new LedgerAtomicAuditError(
      "ledgerD1 needs AsyncLocalStorage (Workers: compatibility flag nodejs_compat or nodejs_als) to keep one request's writes apart from another's",
    );
  }
  const host = globalThis as StorageHost;
  host[STORAGE_KEY] ??= new AsyncLocalStorage<CaptureScope>();
  return host[STORAGE_KEY];
}

const FAKE_RESULT: D1ResultLike = {
  results: [],
  success: true,
  meta: { changes: 0, last_row_id: 0, duration: 0 },
};

/**
 * Wrap a D1 binding for atomic audit. Pass the result to better-auth as
 * `database`, then add ledgerPlugin({ auditTables }) with no writeAuditEntry:
 *
 * ```typescript
 * betterAuth({
 *   database: ledgerD1(env.DB),
 *   plugins: [ledgerPlugin({ auditTables: ["user", "account", "organization"] })],
 * });
 * ```
 *
 * Outside an audited write the wrapper is the binding: every call passes
 * through unchanged.
 */
export function ledgerD1<T extends D1Like>(database: T): T {
  const storage = captureStorage();
  const realOf = new WeakMap<object, D1StatementLike>();

  const wrap = (real: D1StatementLike): D1StatementLike => {
    const run = (method: "all" | "run" | "first" | "raw") => async (): Promise<never> => {
      const scope = storage.getStore();
      if (scope === undefined) return real[method]() as never;
      scope.statements.push(real);
      if (method === "first") return null as never;
      if (method === "raw") return [] as never;
      return FAKE_RESULT as never;
    };
    const wrapped: D1StatementLike = {
      bind: (...values) => wrap(real.bind(...values)),
      all: run("all"),
      run: run("run"),
      first: run("first"),
      raw: run("raw"),
    };
    realOf.set(wrapped, real);
    return wrapped;
  };

  const unwrap = (statement: D1StatementLike): D1StatementLike =>
    realOf.get(statement) ?? statement;

  const handle: D1Handle = {
    capture: async (fn) => {
      const scope: CaptureScope = { statements: [] };
      await storage.run(scope, fn);
      return scope.statements;
    },
    prepare: (sql) => database.prepare(sql),
    batch: (statements) => database.batch(statements.map(unwrap)),
  };

  return new Proxy(database, {
    get(target, property) {
      if (property === HANDLE_KEY) return handle;
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (property === "batch") return handle.batch;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The handle a ledgerD1-wrapped binding carries, or null for anything else. */
export function d1HandleOf(database: unknown): D1Handle | null {
  if (typeof database !== "object" || database === null) return null;
  const handle = (database as { [HANDLE_KEY]?: D1Handle })[HANDLE_KEY];
  return handle ?? null;
}

/** True for a D1 binding by shape: the same test better-auth uses to pick its D1 dialect. */
export function looksLikeD1(database: unknown): boolean {
  return (
    typeof database === "object" &&
    database !== null &&
    "batch" in database &&
    "exec" in database &&
    "prepare" in database
  );
}

type Tables = AuthContext["tables"];

interface TableInfo {
  /** Physical table name, quoted for SQL. */
  table: string;
  /** Better-auth field names, id first. */
  keys: string[];
  /** Quoted physical column of a better-auth field name. */
  column(key: string): string;
  has(key: string): boolean;
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function tableInfo(tables: Tables, model: string): TableInfo {
  const definition = tables[model];
  if (definition === undefined) {
    throw new LedgerAtomicAuditError(`${model} is not a model in the better-auth schema`);
  }
  const fields = definition.fields as Record<string, { fieldName?: string }>;
  const keys = ["id", ...Object.keys(fields).filter((key) => key !== "id")];
  return {
    table: quote(definition.modelName),
    keys,
    column: (key) => quote(fields[key]?.fieldName ?? key),
    has: (key) => keys.includes(key),
  };
}

/** What the D1 wrapper needs beyond the shared atomic environment. */
export interface D1Env extends AtomicEnv {
  d1: D1Handle;
  tables: Tables;
  /** The id better-auth would give a new row of this model, or false when the database assigns it. */
  generateId: (model: string) => string | false;
}

const PROBE = "\u0000ledger-probe";

interface Audited {
  info: TableInfo;
  /** field key -> redacted literal, for columns the redaction rules hide */
  hidden: Map<string, unknown>;
}

function expectOne(statements: D1StatementLike[], model: string): D1StatementLike {
  const [only] = statements;
  if (statements.length !== 1 || only === undefined) {
    throw new LedgerAtomicAuditError(
      `the ${model} write ran ${statements.length} statements where one was expected, so it cannot be audited in one batch; nothing was written`,
    );
  }
  return only;
}

/**
 * Wrap a better-auth adapter built over a ledgerD1 binding so audited models
 * write atomically with their audit row, in one D1 batch.
 */
export function d1Adapter(adapter: Adapter, env: D1Env): Adapter {
  const auditTable = tableInfo(env.tables, LEDGER_AUDIT_MODEL);
  const auditColumns = [
    "id",
    "tableName",
    "recordId",
    "action",
    "oldData",
    "newData",
    "userId",
    "subjectUserId",
    "createdAt",
  ].map((key) => auditTable.column(key));
  const auditedByKey = new Map<string, Audited>();

  const keyOf = (model: string): string | undefined => env.audited.get(model);

  function audited(key: string): Audited {
    const known = auditedByKey.get(key);
    if (known !== undefined) return known;
    const info = tableInfo(env.tables, key);
    // The redaction rules are keyed on field names, so a probe row with
    // every field set shows exactly which columns they hide.
    const probe: Row = Object.fromEntries(info.keys.map((field) => [field, PROBE]));
    const redacted = env.redact(key, probe);
    const hidden = new Map<string, unknown>();
    for (const field of info.keys) {
      const value = redacted?.[field];
      if (value !== PROBE) hidden.set(field, value ?? null);
    }
    const entry = { info, hidden };
    auditedByKey.set(key, entry);
    return entry;
  }

  /** json_object(...) over one row's stored columns, keyed by better-auth field names. */
  function jsonOf(entry: Audited): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const parts: string[] = [];
    for (const field of entry.info.keys) {
      params.push(field);
      if (entry.hidden.has(field)) {
        params.push(entry.hidden.get(field));
        parts.push("?, ?");
      } else {
        parts.push(`?, ${entry.info.column(field)}`);
      }
    }
    return { sql: `json_object(${parts.join(", ")})`, params };
  }

  function subjectColumn(key: string, info: TableInfo): string {
    if (key === "user") return info.column("id");
    return info.has("userId") ? info.column("userId") : "NULL";
  }

  /**
   * One audit row for one record, read from the table by id. `side` says
   * which JSON column the row's state fills: the before-image (oldData) or
   * the after-image (newData). The other side is bound.
   */
  function rowStatement(
    key: string,
    action: AtomicAction,
    id: string,
    side: "old" | "new",
    actor: string | null,
    auditId: string,
  ): D1StatementLike {
    const entry = audited(key);
    const json = jsonOf(entry);
    const params: unknown[] = [auditId, key];
    // SELECT list in column order: id, tableName, recordId, action, oldData,
    // newData, userId, subjectUserId, createdAt.
    const list = [
      "?",
      "?",
      entry.info.column("id"),
      "?",
      side === "old" ? json.sql : "NULL",
      side === "new" ? json.sql : "NULL",
      "?",
      subjectColumn(key, entry.info),
      "?",
    ];
    params.push(action);
    params.push(...json.params);
    params.push(actor, new Date().toISOString(), id);
    const sql = `INSERT INTO ${auditTable.table} (${auditColumns.join(", ")}) SELECT ${list.join(", ")} FROM ${entry.info.table} WHERE ${entry.info.column("id")} = ?`;
    return env.d1.prepare(sql).bind(...params);
  }

  /** Fill an earlier audit row's newData from the changed row. */
  function fillNewStatement(key: string, id: string, auditId: string): D1StatementLike {
    const entry = audited(key);
    const json = jsonOf(entry);
    const sql = `UPDATE ${auditTable.table} SET ${auditTable.column("newData")} = (SELECT ${json.sql} FROM ${entry.info.table} WHERE ${entry.info.column("id")} = ?) WHERE ${auditTable.column("id")} = ?`;
    return env.d1.prepare(sql).bind(...json.params, id, auditId);
  }

  /** Fails the whole batch, by raising a SQL error, unless the previous statement changed `count` rows. */
  function guardStatement(count: number): D1StatementLike {
    return env.d1.prepare("SELECT json('{') WHERE changes() <> ?").bind(count);
  }

  interface Plan {
    /** Audit statements that must see the rows as they stand before the change. */
    before: D1StatementLike[];
    /** How many rows the change must touch; a different count aborts the batch. */
    expect: number | null;
    /** Audit statements that read the rows the change left. */
    after: D1StatementLike[];
  }

  /** Audit the rows an update touches: before-image first, then fill newData after the change. */
  function updatePlan(
    key: string,
    action: AtomicAction,
    ids: string[],
    actorOf: (id: string) => string | null,
  ): Plan {
    const auditIds = ids.map(() => uuidv7());
    return {
      before: ids.map((id, index) =>
        rowStatement(key, action, id, "old", actorOf(id), auditIds[index] ?? ""),
      ),
      expect: ids.length,
      after: ids.map((id, index) => fillNewStatement(key, id, auditIds[index] ?? "")),
    };
  }

  /** Capture the change, then run [before, change, guard, after] as one batch. */
  async function commit(
    key: string,
    change: () => Promise<unknown>,
    plan: Plan,
  ): Promise<D1ResultLike> {
    const changeStatement = expectOne(await env.d1.capture(change), key);
    const batch = [
      ...plan.before,
      changeStatement,
      ...(plan.expect === null ? [] : [guardStatement(plan.expect)]),
      ...plan.after,
    ];
    let results: D1ResultLike[];
    try {
      results = await env.d1.batch(batch);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (plan.expect !== null && /malformed JSON/i.test(text)) {
        throw new LedgerAtomicAuditError(
          `the ${key} rows changed between the read and the write, so the batch was rolled back; nothing was written, retry`,
        );
      }
      throw error;
    }
    const result = results[plan.before.length];
    if (result === undefined) {
      throw new LedgerAtomicAuditError(`the ${key} batch returned no result for the change`);
    }
    return result;
  }

  const ops: Tx = {
    id: adapter.id,
    options: adapter.options,
    createSchema: adapter.createSchema,
    findOne: (args) => adapter.findOne(args),
    findMany: (args) => adapter.findMany(args),
    count: (args) => adapter.count(args),

    create: async (args) => {
      const key = keyOf(args.model);
      if (key === undefined) return adapter.create(args);
      const { clean, marks } = split(args.data as Row);
      // The id has to be known before the batch runs, to read the new row back by it.
      const supplied = clean["id"];
      const generated = typeof supplied === "string" ? supplied : env.generateId(key);
      if (generated === false) {
        throw new LedgerAtomicAuditError(
          `better-auth leaves the ${key} id to the database, so its audit entry cannot name the row inside the batch; enable better-auth id generation. Nothing was written.`,
        );
      }
      const id = generated;
      const data: Row = { ...clean, id };
      const auditId = uuidv7();
      const actor = actorFor(key, "INSERT", marks[ACTOR_KEY], { id });
      await commit(
        key,
        () => adapter.create({ ...args, data: data as typeof args.data, forceAllowId: true }),
        {
          before: [],
          expect: null,
          after: [rowStatement(key, "INSERT", id, "new", actor, auditId)],
        },
      );
      return (await adapter.findOne({
        model: args.model,
        where: [{ field: "id", value: id }],
      })) as never;
    },

    update: async (args) => {
      const key = keyOf(args.model);
      if (key === undefined) return adapter.update(args);
      const { clean, marks } = split(args.update);
      const rows = await adapter.findMany<Row>({ model: args.model, where: args.where });
      const ids = rows.map((row) => idOf(key, row));
      const action = marks[SOFT_DELETE_KEY] === true ? "SOFT_DELETE" : "UPDATE";
      await commit(
        key,
        () => adapter.update<Row>({ ...args, update: clean }),
        updatePlan(key, action, ids, (id) => actorFor(key, action, marks[ACTOR_KEY], { id })),
      );
      const first = ids[0];
      if (first === undefined) return null as never;
      return (await adapter.findOne({
        model: args.model,
        where: [{ field: "id", value: first }],
      })) as never;
    },

    updateMany: async (args) => {
      const key = keyOf(args.model);
      if (key === undefined) return adapter.updateMany(args);
      const { clean, marks } = split(args.update);
      const rows = await adapter.findMany<Row>({ model: args.model, where: args.where });
      const ids = rows.map((row) => idOf(key, row));
      const result = await commit(
        key,
        () => adapter.updateMany({ ...args, update: clean }),
        updatePlan(key, "UPDATE", ids, (id) => actorFor(key, "UPDATE", marks[ACTOR_KEY], { id })),
      );
      return result.meta.changes ?? 0;
    },

    delete: async (args) => {
      const key = keyOf(args.model);
      if (key === undefined) return adapter.delete(args);
      await deleteRows(key, args.model, args.where, () => adapter.delete(args));
    },

    deleteMany: async (args) => {
      const key = keyOf(args.model);
      if (key === undefined) return adapter.deleteMany(args);
      return deleteRows(key, args.model, args.where, () => adapter.deleteMany(args));
    },

    consumeOne: async (args) => {
      const key = keyOf(args.model);
      if (key === undefined) return adapter.consumeOne(args);
      const row = await adapter.findOne<Row>({ model: args.model, where: args.where });
      if (row === null) return null as never;
      const id = idOf(key, row);
      const actor = env.takeDeleteActor(key, id) ?? actorFor(key, "DELETE", undefined, { id });
      // Claim by id: of two callers racing for one token, the delete changes
      // a row for one of them only, and the other's audit SELECT finds no row.
      const result = await commit(
        key,
        () => adapter.delete({ model: args.model, where: [{ field: "id", value: id }] as Where }),
        {
          before: [rowStatement(key, "DELETE", id, "old", actor, uuidv7())],
          expect: null,
          after: [],
        },
      );
      return ((result.meta.changes ?? 0) > 0 ? row : null) as never;
    },

    incrementOne: async (args) => {
      const key = keyOf(args.model);
      if (key === undefined) return adapter.incrementOne(args);
      const row = await adapter.findOne<Row>({ model: args.model, where: args.where });
      const ids = row === null ? [] : [idOf(key, row)];
      await commit(
        key,
        () => adapter.incrementOne<Row>(args),
        updatePlan(key, "UPDATE", ids, (id) => actorFor(key, "UPDATE", undefined, { id })),
      );
      const first = ids[0];
      if (first === undefined) return null as never;
      return (await adapter.findOne({
        model: args.model,
        where: [{ field: "id", value: first }],
      })) as never;
    },
  };

  async function deleteRows(
    key: string,
    model: string,
    where: Where,
    change: () => Promise<unknown>,
  ): Promise<number> {
    const rows = await adapter.findMany<Row>({ model, where });
    const ids = rows.map((row) => idOf(key, row));
    const result = await commit(key, change, {
      // The audit SELECTs run before the delete, while the rows still exist.
      before: ids.map((id) =>
        rowStatement(
          key,
          "DELETE",
          id,
          "old",
          env.takeDeleteActor(key, id) ?? actorFor(key, "DELETE", undefined, { id }),
          uuidv7(),
        ),
      ),
      expect: ids.length,
      after: [],
    });
    return result.meta.changes ?? 0;
  }

  return {
    ...ops,
    // D1 cannot hold a transaction open: calls inside run in sequence, and
    // each audited write is atomic with its own audit row.
    transaction: (callback) => callback(ops),
  };
}
