/**
 * Atomic audit for the better-auth plugin.
 *
 * Wraps better-auth's database adapter so every write to an audited model
 * and its audit row go through ONE adapter transaction: both commit or both
 * roll back. The wrapper sits under everything that writes (internalAdapter,
 * plugin endpoints that call ctx.context.adapter directly), so core and
 * plugin tables are covered the same way.
 *
 * The audit row is written through the same transaction handle as the
 * change, as a better-auth model declared by the plugin's schema
 * (LEDGER_AUDIT_MODEL), so it never depends on a second database handle.
 */

import type { AuthContext, BetterAuthPlugin } from "better-auth";
import { uuidv7 } from "uuidv7";
import { getLedgerContext } from "./core/context.js";

type Adapter = AuthContext["adapter"];
/** The adapter handle inside a transaction: every operation but transaction(). */
type Tx = Parameters<Parameters<Adapter["transaction"]>[0]>[0];
type Where = NonNullable<Parameters<Tx["findMany"]>[0]["where"]>;
type Row = Record<string, unknown>;

export type AtomicAction = "INSERT" | "UPDATE" | "SOFT_DELETE" | "DELETE";

/** The model key of the audit table the atomic path writes. */
export const LEDGER_AUDIT_MODEL = "ledgerAudit";
/** The physical table name of that model. */
export const LEDGER_AUDIT_TABLE = "ledger_audit_log";

/**
 * Plugin schema for the atomic audit table. Columns (better-auth field
 * names; the physical column names are the same):
 *
 * - id: UUIDv7
 * - tableName / recordId: the model and the id of the row that changed
 * - action: INSERT, UPDATE, SOFT_DELETE, or DELETE
 * - oldData / newData: the redacted row before and after, as JSON text
 * - userId: the actor, null when unknown
 * - subjectUserId: the user the change concerns (see subjectOf)
 * - createdAt
 */
export const ledgerAuditSchema = {
  [LEDGER_AUDIT_MODEL]: {
    modelName: LEDGER_AUDIT_TABLE,
    fields: {
      tableName: { type: "string", required: true },
      recordId: { type: "string", required: true, index: true },
      action: { type: "string", required: true },
      oldData: { type: "string", required: false },
      newData: { type: "string", required: false },
      userId: { type: "string", required: false, index: true },
      subjectUserId: { type: "string", required: false, index: true },
      createdAt: { type: "date", required: true },
    },
  },
} satisfies NonNullable<BetterAuthPlugin["schema"]>;

/** Carries the hook context's actor from a before hook to the wrapper, inside the write's own data. */
export const ACTOR_KEY: unique symbol = Symbol.for("@rafters/ledger.actor");
/** Marks the softDeleteUser update so the wrapper records SOFT_DELETE, not UPDATE. */
export const SOFT_DELETE_KEY: unique symbol = Symbol.for("@rafters/ledger.soft-delete");

export type Marked = Row & { [ACTOR_KEY]?: string; [SOFT_DELETE_KEY]?: true };

/** Raised when the atomic audit row cannot be built; the change is rolled back. */
export class LedgerAtomicAuditError extends Error {
  constructor(message: string) {
    super(`[ledger] ${message}`);
    this.name = "LedgerAtomicAuditError";
  }
}

/**
 * The user a change concerns. A user row concerns itself; any other row
 * concerns the user named by its userId field; a row with no userId
 * (organization, for one) concerns no single user and gets null. The
 * row's data stays in oldData/newData either way.
 */
export function subjectOf(model: string, row: Row | null): string | null {
  if (row === null) return null;
  if (model === "user") return typeof row["id"] === "string" ? row["id"] : null;
  return typeof row["userId"] === "string" ? row["userId"] : null;
}

export function idOf(model: string, row: Row | null): string {
  const id = row?.["id"];
  if (typeof id === "string" || typeof id === "number") return String(id);
  throw new LedgerAtomicAuditError(
    `a ${model} row has no id, so its audit entry cannot name the record; the change was not written`,
  );
}

export function split(source: Row | undefined): { clean: Row; marks: Marked } {
  const marks: Marked = {};
  if (source === undefined) return { clean: {}, marks };
  const clean: Row = { ...source };
  const actor = (source as Marked)[ACTOR_KEY];
  if (typeof actor === "string") marks[ACTOR_KEY] = actor;
  if ((source as Marked)[SOFT_DELETE_KEY] === true) marks[SOFT_DELETE_KEY] = true;
  return { clean, marks };
}

/** What the wrapper needs from the plugin. */
export interface AtomicEnv {
  /** model name (key or physical name) -> model key, audited models only */
  audited: ReadonlyMap<string, string>;
  /** Redact a payload for a model; throws when it cannot (fail closed). */
  redact: (model: string, data: Row | null) => Row | null;
  /** The actor a delete.before hook stashed for this row, consumed once. */
  takeDeleteActor: (model: string, id: string) => string | null;
}

export function actorFor(
  model: string,
  action: AtomicAction,
  hooked: string | undefined,
  row: Row | null,
): string | null {
  const known = hooked ?? getLedgerContext()?.userId ?? null;
  if (known !== null) return known;
  // Self-signup and user deletion: the target is the actor.
  if (model === "user" && action !== "UPDATE") {
    return typeof row?.["id"] === "string" ? row["id"] : null;
  }
  return null;
}

async function record(
  tx: Tx,
  env: AtomicEnv,
  model: string,
  action: AtomicAction,
  before: Row | null,
  after: Row | null,
  hooked: string | undefined,
): Promise<void> {
  const row = after ?? before;
  const oldData = env.redact(model, before);
  const newData = env.redact(model, after);
  await tx.create({
    model: LEDGER_AUDIT_MODEL,
    forceAllowId: true,
    data: {
      id: uuidv7(),
      tableName: model,
      recordId: idOf(model, row),
      action,
      oldData: oldData === null ? null : JSON.stringify(oldData),
      newData: newData === null ? null : JSON.stringify(newData),
      userId: actorFor(model, action, hooked, row),
      subjectUserId: subjectOf(model, row),
      createdAt: new Date(),
    },
  });
}

type Run = <R>(fn: (tx: Tx) => Promise<R>) => Promise<R>;

function ops(raw: Tx, run: Run, env: AtomicEnv): Tx {
  const keyOf = (model: string): string | undefined => env.audited.get(model);

  const idsOf = (model: string, rows: Row[]): string[] => rows.map((row) => idOf(model, row));

  return {
    id: raw.id,
    options: raw.options,
    createSchema: raw.createSchema,
    findOne: (args) => raw.findOne(args),
    findMany: (args) => raw.findMany(args),
    count: (args) => raw.count(args),

    create: async (args) => {
      const key = keyOf(args.model);
      if (key === undefined) return raw.create(args);
      const { clean, marks } = split(args.data as Row);
      return run(async (tx) => {
        const created = (await tx.create({ ...args, data: clean as typeof args.data })) as Row;
        await record(tx, env, key, "INSERT", null, created, marks[ACTOR_KEY]);
        return created as never;
      });
    },

    update: async (args) => {
      const key = keyOf(args.model);
      if (key === undefined) return raw.update(args);
      const { clean, marks } = split(args.update);
      return run(async (tx) => {
        const before = await tx.findOne<Row>({ model: args.model, where: args.where });
        const updated = await tx.update<Row>({ ...args, update: clean });
        if (updated !== null) {
          const action = marks[SOFT_DELETE_KEY] === true ? "SOFT_DELETE" : "UPDATE";
          await record(tx, env, key, action, before, updated, marks[ACTOR_KEY]);
        }
        return updated as never;
      });
    },

    updateMany: async (args) => {
      const key = keyOf(args.model);
      if (key === undefined) return raw.updateMany(args);
      const { clean, marks } = split(args.update);
      return run(async (tx) => {
        const before = await tx.findMany<Row>({ model: args.model, where: args.where });
        const count = await tx.updateMany({ ...args, update: clean });
        if (before.length > 0) {
          const ids = idsOf(key, before);
          const after = await tx.findMany<Row>({
            model: args.model,
            where: [{ field: "id", operator: "in", value: ids }] as Where,
          });
          const afterById = new Map(after.map((row) => [idOf(key, row), row]));
          for (const [index, old] of before.entries()) {
            const id = ids[index];
            const next = id === undefined ? undefined : afterById.get(id);
            if (next) await record(tx, env, key, "UPDATE", old, next, marks[ACTOR_KEY]);
          }
        }
        return count;
      });
    },

    delete: async (args) => {
      const key = keyOf(args.model);
      if (key === undefined) return raw.delete(args);
      return run(async (tx) => {
        const before = await tx.findMany<Row>({ model: args.model, where: args.where });
        await tx.delete(args);
        for (const old of before) {
          await record(
            tx,
            env,
            key,
            "DELETE",
            old,
            null,
            env.takeDeleteActor(key, idOf(key, old)) ?? undefined,
          );
        }
      });
    },

    deleteMany: async (args) => {
      const key = keyOf(args.model);
      if (key === undefined) return raw.deleteMany(args);
      return run(async (tx) => {
        const before = await tx.findMany<Row>({ model: args.model, where: args.where });
        const count = await tx.deleteMany(args);
        for (const old of before) {
          await record(
            tx,
            env,
            key,
            "DELETE",
            old,
            null,
            env.takeDeleteActor(key, idOf(key, old)) ?? undefined,
          );
        }
        return count;
      });
    },

    consumeOne: async (args) => {
      const key = keyOf(args.model);
      if (key === undefined) return raw.consumeOne(args);
      return run(async (tx) => {
        const consumed = await tx.consumeOne<Row>(args);
        if (consumed !== null) {
          const actor = env.takeDeleteActor(key, idOf(key, consumed)) ?? undefined;
          await record(tx, env, key, "DELETE", consumed, null, actor);
        }
        return consumed as never;
      });
    },

    incrementOne: async (args) => {
      const key = keyOf(args.model);
      if (key === undefined) return raw.incrementOne(args);
      return run(async (tx) => {
        const before = await tx.findOne<Row>({ model: args.model, where: args.where });
        const updated = await tx.incrementOne<Row>(args);
        if (updated !== null) await record(tx, env, key, "UPDATE", before, updated, undefined);
        return updated as never;
      });
    },
  };
}

/**
 * Wrap an adapter so audited models write atomically with their audit row.
 * The transaction handed to better-auth (runWithTransaction) is wrapped
 * too: inside it, change and audit row join the outer transaction instead
 * of opening a second one.
 */
export function atomicAdapter(adapter: Adapter, env: AtomicEnv): Adapter {
  const wrappedTx = (trx: Tx): Tx => ops(trx, (fn) => fn(trx), env);
  const top = ops(adapter, (fn) => adapter.transaction(fn), env);
  return {
    ...top,
    transaction: (callback) => adapter.transaction((trx) => callback(wrappedTx(trx))),
  };
}

/** True when the adapter runs transaction() as a real transaction. */
export function supportsTransactions(adapter: Adapter): boolean {
  return Boolean(adapter.options?.adapterConfig.transaction);
}
