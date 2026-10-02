/**
 * Kysely soft-delete and audit plugin for SQLite and Cloudflare D1.
 *
 * The schema is the declaration: a table soft-deletes if and only if it has a
 * `deleted_at` column. Every insert, update, and delete appends value-free
 * entries (field names only) to the audit table from `sql/sqlite/audit.sql`.
 *
 * Mechanism: `transformQuery` adds `RETURNING <primary key>` to each write (and
 * rewrites a DELETE on a soft-delete table into an UPDATE); `transformResult`
 * reads the returned keys, writes one audit entry per affected row, and hands
 * the caller a result shaped as if nothing had been added.
 */

import {
  AliasNode,
  ColumnNode,
  ColumnUpdateNode,
  createQueryId,
  DeleteQueryNode,
  type Dialect,
  IdentifierNode,
  InsertQueryNode,
  Kysely,
  type KyselyPlugin,
  type OperationNode,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  RawNode,
  ReferenceNode,
  ReturningNode,
  type RootOperationNode,
  SelectionNode,
  sql,
  TableNode,
  type UnknownRow,
  UpdateQueryNode,
  ValueNode,
  WhereNode,
} from "kysely";
import { uuidv7 } from "uuidv7";
import { getLedgerContext } from "../core/context.js";
import type { LedgerContext, ValueFreeAuditEntry } from "../core/types.js";
import {
  LedgerAuditTableMissingError,
  LedgerNotReadyError,
  LedgerRawDeleteError,
  LedgerUnknownTableError,
  LedgerUnsupportedStatementError,
} from "./errors.js";

export interface LedgerKyselyOptions {
  /**
   * The same dialect you pass to `new Kysely`. The plugin opens its own
   * Kysely instance on it to read the schema and write audit entries, so
   * those writes never pass through the plugin itself.
   */
  dialect: Dialect;
  /** Audit table created by `sql/sqlite/audit.sql`. Default `ledger_audit`. */
  auditTable?: string;
  /** Receives the startup log line. Default `console.info`. */
  log?: (message: string) => void;
}

type AuditAction = ValueFreeAuditEntry["action"];

interface AuditRow {
  id: string;
  table_name: string;
  record_id: string;
  action: AuditAction;
  changed_fields: string;
  user_id: string | null;
  ip: string | null;
  user_agent: string | null;
  endpoint: string | null;
  request_id: string | null;
  created_at: number;
}

interface TableInfo {
  /** Primary key columns in key order; empty means the table is addressed by rowid. */
  primaryKey: readonly string[];
  softDeletes: boolean;
}

interface Pending {
  table: string;
  action: AuditAction;
  changedFields: readonly string[];
  aliases: readonly string[];
  userReturning: boolean;
  actor: LedgerContext | null;
  /** For a soft delete: the UPDATE to run in place of the DELETE. */
  softDelete?: UpdateQueryNode;
}

const PK_ALIAS_PREFIX = "__ledger_pk_";
const DELETED_AT = "deleted_at";
// D1 allows 100 bound parameters per statement; an entry binds 11.
const ENTRIES_PER_STATEMENT = 8;
const RAW_DELETE_PATTERN =
  /\bdelete\s+from\s+(?:(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$]+)\s*\.\s*)*("[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$]+|\?)/gi;

function unquote(identifier: string): string {
  const first = identifier[0];
  if (first === '"' || first === "`" || first === "[") return identifier.slice(1, -1);
  return identifier;
}

function tableName(node: OperationNode | undefined): string | null {
  if (node === undefined) return null;
  if (AliasNode.is(node)) return tableName(node.node);
  if (TableNode.is(node)) return node.table.identifier.name;
  return null;
}

const UNRESOLVED = "?";

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Rebuild a raw statement's text, inlining identifiers and marking every other parameter. */
function renderRaw(node: RawNode): string {
  let text = node.sqlFragments[0] ?? "";
  node.parameters.forEach((parameter, index) => {
    text += renderParameter(parameter) + (node.sqlFragments[index + 1] ?? "");
  });
  return text;
}

function renderParameter(node: OperationNode): string {
  if (RawNode.is(node)) return renderRaw(node);
  if (TableNode.is(node)) {
    const { schema, identifier } = node.table;
    return `${schema ? `${quoted(schema.name)}.` : ""}${quoted(identifier.name)}`;
  }
  if (IdentifierNode.is(node)) return quoted(node.name);
  if (ColumnNode.is(node)) return quoted(node.column.name);
  return UNRESOLVED;
}

function updatedColumns(node: UpdateQueryNode): string[] {
  const names: string[] = [];
  for (const update of node.updates ?? []) {
    const column = update.column;
    if (ColumnNode.is(column)) {
      names.push(column.column.name);
    } else if (ReferenceNode.is(column) && ColumnNode.is(column.column)) {
      names.push(column.column.column.name);
    }
  }
  return names;
}

interface Keys {
  selections: SelectionNode[];
  returning: ReturningNode | undefined;
}

/**
 * Add the key selections to a write. When the caller has no RETURNING, the
 * clause goes in as an end modifier instead: Kysely shapes the caller's result
 * from the node's `returning`, so setting it would turn an InsertResult into rows.
 */
function withKeys<N extends InsertQueryNode | UpdateQueryNode | DeleteQueryNode>(
  node: N,
  keys: Keys,
): N {
  if (keys.returning !== undefined) return { ...node, returning: keys.returning };
  const fragments = ["returning ", ...keys.selections.slice(1).map(() => ", "), ""];
  const clause = RawNode.create(fragments, keys.selections);
  return { ...node, endModifiers: [clause, ...(node.endModifiers ?? [])] };
}

export class LedgerKyselyPlugin implements KyselyPlugin {
  readonly #db: Kysely<Record<string, AuditRow>>;
  readonly #auditTable: string;
  readonly #log: (message: string) => void;
  readonly #pending = new WeakMap<object, Pending>();
  #tables: Map<string, TableInfo> | null = null;
  #loading: Promise<void> | null = null;
  #loadError: unknown;

  constructor(options: LedgerKyselyOptions) {
    this.#db = new Kysely<Record<string, AuditRow>>({ dialect: options.dialect });
    this.#auditTable = options.auditTable ?? "ledger_audit";
    this.#log = options.log ?? ((message) => console.info(message));
    void this.refresh().catch(() => {});
  }

  /** Resolves once the schema is read; rejects if it could not be. */
  ready(): Promise<void> {
    return this.#loading ?? this.refresh();
  }

  /** Read the schema again, for tables created after startup (for example by a migration). */
  refresh(): Promise<void> {
    const loading = this.#load().then(
      () => {
        this.#loadError = undefined;
      },
      (error: unknown) => {
        this.#loadError = error;
        throw error;
      },
    );
    this.#loading = loading;
    return loading;
  }

  /** Tables that soft-delete, as read from the schema. Empty until ready. */
  softDeleteTables(): string[] {
    if (this.#tables === null) return [];
    return [...this.#tables]
      .filter(([, info]) => info.softDeletes)
      .map(([name]) => name)
      .sort();
  }

  async #load(): Promise<void> {
    const tables = await this.#db.introspection.getTables();
    const loaded = new Map<string, TableInfo>();
    let auditFound = false;
    for (const table of tables) {
      if (table.name === this.#auditTable) {
        auditFound = true;
        continue;
      }
      if (table.isView) continue;
      const keys = await sql<{ name: string }>`
        select name from pragma_table_info(${table.name}) where pk > 0 order by pk
      `.execute(this.#db);
      loaded.set(table.name.toLowerCase(), {
        primaryKey: keys.rows.map((row) => row.name),
        softDeletes: table.columns.some((column) => column.name === DELETED_AT),
      });
    }
    if (!auditFound) throw new LedgerAuditTableMissingError(this.#auditTable);
    this.#tables = loaded;
    const names = this.softDeleteTables();
    this.#log(`[ledger] soft-delete tables: ${names.length === 0 ? "none" : names.join(", ")}`);
  }

  #requireTables(): Map<string, TableInfo> {
    if (this.#tables !== null) return this.#tables;
    const cause = this.#loadError;
    if (cause !== undefined) void this.refresh().catch(() => {});
    throw new LedgerNotReadyError(cause);
  }

  transformQuery({ node, queryId }: PluginTransformQueryArgs): RootOperationNode {
    if (RawNode.is(node)) {
      this.#checkRaw(node);
      return node;
    }
    if (InsertQueryNode.is(node)) {
      const name = tableName(node.into);
      if (name === null || name === this.#auditTable) return node;
      return withKeys(node, this.#track(queryId, name, "INSERT", [], node.returning));
    }
    if (UpdateQueryNode.is(node)) {
      const name = tableName(node.table);
      if (name === null || name === this.#auditTable) return node;
      const fields = updatedColumns(node);
      return withKeys(node, this.#track(queryId, name, "UPDATE", fields, node.returning));
    }
    if (DeleteQueryNode.is(node)) {
      return this.#transformDelete(node, queryId);
    }
    return node;
  }

  #transformDelete(node: DeleteQueryNode, queryId: object): RootOperationNode {
    const froms = node.from.froms;
    const target = froms[0];
    const name = froms.length === 1 ? tableName(target) : null;
    if (name === null || target === undefined) {
      throw new LedgerUnsupportedStatementError("DELETE must target exactly one table");
    }
    if (name === this.#auditTable) return node;
    const info = this.#requireTables().get(name.toLowerCase());
    if (info === undefined) throw new LedgerUnknownTableError(name);
    if (!info.softDeletes) {
      return withKeys(node, this.#track(queryId, name, "DELETE", [], node.returning));
    }
    const keys = this.#track(queryId, name, "SOFT_DELETE", [DELETED_AT], node.returning);
    const pending = this.#pending.get(queryId);
    if (pending === undefined)
      throw new LedgerUnsupportedStatementError("statement was not tracked");
    pending.softDelete = {
      ...UpdateQueryNode.create([target], node.with),
      updates: [
        ColumnUpdateNode.create(ColumnNode.create(DELETED_AT), ValueNode.create(Date.now())),
      ],
      where: node.where,
      joins: node.joins,
      orderBy: node.orderBy,
      limit: node.limit,
      returning: keys.returning ?? ReturningNode.create(keys.selections),
    };
    // Kysely requires a plugin to return the node kind it was given, so the
    // DELETE stays a DELETE that matches nothing; transformResult runs the
    // UPDATE above and reports its rows in place of this statement's.
    return { ...node, where: WhereNode.create(RawNode.createWithSql("0")) };
  }

  /**
   * Record what `transformResult` needs and return the RETURNING selections
   * that fetch the affected rows' keys. `returning` is set only when the
   * caller already asked for RETURNING.
   */
  #track(
    queryId: object,
    table: string,
    action: AuditAction,
    changedFields: readonly string[],
    userReturning: ReturningNode | undefined,
  ): Keys {
    const info = this.#requireTables().get(table.toLowerCase());
    if (info === undefined) throw new LedgerUnknownTableError(table);
    const columns = info.primaryKey.length > 0 ? info.primaryKey : ["rowid"];
    const aliases = columns.map((_, index) => `${PK_ALIAS_PREFIX}${index}`);
    const selections = columns.map((column, index) =>
      SelectionNode.create(
        AliasNode.create(
          ReferenceNode.create(ColumnNode.create(column)),
          IdentifierNode.create(aliases[index] as string),
        ),
      ),
    );
    this.#pending.set(queryId, {
      table,
      action,
      changedFields,
      aliases,
      userReturning: userReturning !== undefined,
      actor: getLedgerContext(),
    });
    return {
      selections,
      returning:
        userReturning === undefined
          ? undefined
          : ReturningNode.cloneWithSelections(userReturning, [
              ...userReturning.selections,
              ...selections,
            ]),
    };
  }

  #checkRaw(node: RawNode): void {
    const text = renderRaw(node);
    if (!/\bdelete\b/i.test(text)) return;
    const tables = this.#requireTables();
    for (const match of text.matchAll(RAW_DELETE_PATTERN)) {
      const name = unquote(match[1] as string);
      // A target built from a value Kysely cannot name could be any table.
      if (name === UNRESOLVED) throw new LedgerRawDeleteError("(unresolved target)");
      if (name === this.#auditTable) continue;
      if (tables.get(name.toLowerCase())?.softDeletes) throw new LedgerRawDeleteError(name);
    }
  }

  async transformResult({
    queryId,
    result: statementResult,
  }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const pending = this.#pending.get(queryId);
    if (pending === undefined) return statementResult;
    this.#pending.delete(queryId);

    let result = statementResult;
    if (pending.softDelete !== undefined) {
      const executor = this.#db.getExecutor();
      result = await executor.executeQuery(
        executor.compileQuery(pending.softDelete, createQueryId()),
      );
    }

    const recordIds = result.rows.map((row) =>
      recordIdOf(
        pending.aliases.map((alias) => row[alias]),
        pending.aliases.length,
      ),
    );
    if (recordIds.length > 0) await this.#write(pending, recordIds);

    const rows = pending.userReturning
      ? result.rows.map((row) => {
          const kept: UnknownRow = {};
          for (const [key, value] of Object.entries(row)) {
            if (!key.startsWith(PK_ALIAS_PREFIX)) kept[key] = value;
          }
          return kept;
        })
      : [];
    const last = result.rows.at(-1)?.[`${PK_ALIAS_PREFIX}0`];
    const insertId =
      pending.action === "INSERT" && pending.aliases.length === 1 && isIntegerLike(last)
        ? BigInt(last)
        : result.insertId;
    return { ...result, rows, numAffectedRows: BigInt(result.rows.length), insertId };
  }

  async #write(pending: Pending, recordIds: readonly string[]): Promise<void> {
    const actor = pending.actor;
    const now = Date.now();
    const entries: AuditRow[] = recordIds.map((recordId) => ({
      id: uuidv7(),
      table_name: pending.table,
      record_id: recordId,
      action: pending.action,
      changed_fields: JSON.stringify(pending.changedFields),
      user_id: actor?.userId ?? null,
      ip: actor?.ip ?? null,
      user_agent: actor?.userAgent ?? null,
      endpoint: actor?.endpoint ?? null,
      request_id: actor?.requestId ?? null,
      created_at: now,
    }));
    for (let start = 0; start < entries.length; start += ENTRIES_PER_STATEMENT) {
      await this.#db
        .insertInto(this.#auditTable)
        .values(entries.slice(start, start + ENTRIES_PER_STATEMENT))
        .execute();
    }
  }
}

function isIntegerLike(value: unknown): value is number | bigint {
  return typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value));
}

function recordIdOf(values: readonly unknown[], width: number): string {
  if (width === 1) return String(values[0]);
  return JSON.stringify(values.map((value) => String(value)));
}

/**
 * Create the plugin.
 *
 * @example
 * ```typescript
 * const dialect = new D1Dialect({ database: env.DB });
 * const db = new Kysely<Database>({ dialect, plugins: [ledger({ dialect })] });
 * ```
 */
export function ledger(options: LedgerKyselyOptions): LedgerKyselyPlugin {
  return new LedgerKyselyPlugin(options);
}
