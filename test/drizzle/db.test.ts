import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { eq, sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { describe, expect, test, vi } from "vitest";
import {
  type AuditedDbConfig,
  createAuditedDb,
  getTableName,
  hasColumn,
} from "../../src/drizzle/db.js";
import { createLedgerContext, runWithLedgerContext } from "../../src/core/context.js";
import {
  AuditTableDeleteError,
  MissingPrimaryKeyError,
  MissingSoftDeleteColumnError,
  MissingSoftDeleteTablesError,
  UnresolvedSoftDeleteTableError,
} from "../../src/core/errors.js";
import type { AuditLogEntry } from "../../src/core/types.js";

// Test tables
const usersWithSoftDelete = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  deletedBy: text("deleted_by"),
});

const logsWithoutSoftDelete = sqliteTable("logs", {
  id: text("id").primaryKey(),
  message: text("message"),
});

describe("hasColumn", () => {
  test("returns true for existing column", () => {
    expect(hasColumn(usersWithSoftDelete, "deletedAt")).toBe(true);
    expect(hasColumn(usersWithSoftDelete, "id")).toBe(true);
    expect(hasColumn(usersWithSoftDelete, "name")).toBe(true);
  });

  test("returns false for missing column", () => {
    expect(hasColumn(logsWithoutSoftDelete, "deletedAt")).toBe(false);
    expect(hasColumn(usersWithSoftDelete, "nonexistent")).toBe(false);
  });

  test("returns false for null/undefined", () => {
    expect(hasColumn(null, "deletedAt")).toBe(false);
    expect(hasColumn(undefined, "deletedAt")).toBe(false);
  });

  test("returns false for non-objects", () => {
    expect(hasColumn("string", "deletedAt")).toBe(false);
    expect(hasColumn(123, "deletedAt")).toBe(false);
  });
});

describe("getTableName", () => {
  test("returns null for null/undefined", () => {
    expect(getTableName(null)).toBeNull();
    expect(getTableName(undefined)).toBeNull();
  });

  test("returns null for non-objects", () => {
    expect(getTableName("string")).toBeNull();
    expect(getTableName(123)).toBeNull();
  });
});

describe("createAuditedDb", () => {
  function createMockDb() {
    const calls: { method: string; args: unknown[] }[] = [];

    const mockUpdateResult = {
      returning: vi.fn().mockResolvedValue([{ id: "user-123", deletedAt: new Date() }]),
      execute: vi.fn().mockResolvedValue(undefined),
    };

    const mockUpdateWithWhere = {
      where: vi.fn().mockReturnValue(mockUpdateResult),
    };

    const mockUpdateWithSet = {
      set: vi.fn().mockReturnValue(mockUpdateWithWhere),
    };

    const mockDeleteResult = {
      returning: vi.fn().mockResolvedValue([]),
      execute: vi.fn().mockResolvedValue(undefined),
    };

    const mockDeleteWithWhere = {
      where: vi.fn().mockReturnValue(mockDeleteResult),
    };

    const deleteSpy = vi.fn().mockImplementation((table: unknown) => {
      calls.push({ method: "delete", args: [table] });
      return mockDeleteWithWhere;
    });

    const updateSpy = vi.fn().mockImplementation((table: unknown) => {
      calls.push({ method: "update", args: [table] });
      return mockUpdateWithSet;
    });

    return {
      db: {
        delete: deleteSpy,
        update: updateSpy,
      },
      calls,
      deleteSpy,
      updateSpy,
      mockUpdateWithSet,
      mockUpdateWithWhere,
      mockUpdateResult,
      mockDeleteWithWhere,
    };
  }

  test("converts delete to soft-delete for listed tables with deletedAt", () => {
    const { db, updateSpy, mockUpdateWithSet, mockUpdateWithWhere } = createMockDb();

    const auditedDb = createAuditedDb(db, { softDeleteTables: ["users"] });

    const result = auditedDb.delete(usersWithSoftDelete);
    result.where({ id: "user-123" });

    expect(updateSpy).toHaveBeenCalledWith(usersWithSoftDelete);
    expect(mockUpdateWithSet.set).toHaveBeenCalled();
    expect(mockUpdateWithWhere.where).toHaveBeenCalledWith({ id: "user-123" });

    const setCall = mockUpdateWithSet.set.mock.calls[0][0];
    expect(setCall.deletedAt).toBeInstanceOf(Date);
    expect(setCall.deletedBy).toBeNull();
  });

  test("uses regular delete for unlisted tables without deletedAt", () => {
    const { db, deleteSpy, updateSpy, mockDeleteWithWhere } = createMockDb();

    const auditedDb = createAuditedDb(db, { softDeleteTables: ["users"] });

    auditedDb.delete(logsWithoutSoftDelete).where({ id: "log-123" });

    expect(deleteSpy).toHaveBeenCalledWith(logsWithoutSoftDelete);
    expect(mockDeleteWithWhere.where).toHaveBeenCalledWith({ id: "log-123" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test("respects hardDeleteTables config", () => {
    const { db, deleteSpy, updateSpy, mockDeleteWithWhere } = createMockDb();

    const auditedDb = createAuditedDb(db, {
      softDeleteTables: ["users"],
      hardDeleteTables: ["users"],
    });

    auditedDb.delete(usersWithSoftDelete).where({ id: "user-123" });

    expect(deleteSpy).toHaveBeenCalledWith(usersWithSoftDelete);
    expect(mockDeleteWithWhere.where).toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test("captures userId from context for deletedBy", () => {
    const { db, mockUpdateWithSet } = createMockDb();

    const auditedDb = createAuditedDb(db, { softDeleteTables: ["users"] });

    const context = createLedgerContext({ userId: "admin-456" });

    runWithLedgerContext(context, () => {
      auditedDb.delete(usersWithSoftDelete).where({ id: "user-123" });
    });

    const setCall = mockUpdateWithSet.set.mock.calls[0][0];
    expect(setCall.deletedBy).toBe("admin-456");
  });

  test("supports custom softDeleteValuesFactory", () => {
    const { db, mockUpdateWithSet } = createMockDb();

    const customDate = new Date("2024-01-01");
    const auditedDb = createAuditedDb(db, {
      softDeleteTables: ["users"],
      softDeleteValuesFactory: (deletedBy) => ({
        deletedAt: customDate,
        deletedBy: deletedBy ?? "system",
      }),
    });

    auditedDb.delete(usersWithSoftDelete).where({ id: "user-123" });

    const setCall = mockUpdateWithSet.set.mock.calls[0][0];
    expect(setCall.deletedAt).toBe(customDate);
    expect(setCall.deletedBy).toBe("system");
  });

  test("returning() works on soft-delete", async () => {
    const { db, mockUpdateResult } = createMockDb();

    const auditedDb = createAuditedDb(db, { softDeleteTables: ["users"] });

    const result = await auditedDb
      .delete(usersWithSoftDelete)
      .where({ id: "user-123" })
      .returning();

    expect(mockUpdateResult.returning).toHaveBeenCalled();
    expect(result).toEqual([{ id: "user-123", deletedAt: expect.any(Date) }]);
  });

  test("execute() works on soft-delete", async () => {
    const { db, mockUpdateResult } = createMockDb();

    const auditedDb = createAuditedDb(db, { softDeleteTables: ["users"] });

    await auditedDb.delete(usersWithSoftDelete).where({ id: "user-123" }).execute();

    expect(mockUpdateResult.execute).toHaveBeenCalled();
  });

  test("deletes on the audit table throw through the wrapper", () => {
    const { db, deleteSpy, updateSpy } = createMockDb();
    const auditTable = sqliteTable("audit_log", {
      id: text("id").primaryKey(),
    });

    const auditedDb = createAuditedDb(db, { softDeleteTables: ["users"] });

    expect(() => auditedDb.delete(auditTable)).toThrow(AuditTableDeleteError);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test("custom auditTableName is honored by the delete guard", () => {
    const { db, deleteSpy } = createMockDb();
    const customAudit = sqliteTable("my_audit", {
      id: text("id").primaryKey(),
    });

    const auditedDb = createAuditedDb(db, {
      softDeleteTables: ["users"],
      auditTableName: "my_audit",
    });

    expect(() => auditedDb.delete(customAudit)).toThrow(AuditTableDeleteError);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test("does not mutate the original db instance", () => {
    const { db, deleteSpy, updateSpy } = createMockDb();

    createAuditedDb(db, { softDeleteTables: ["users"] });

    // The original reference keeps original hard-delete behavior.
    db.delete(usersWithSoftDelete);
    expect(deleteSpy).toHaveBeenCalledWith(usersWithSoftDelete);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test("directly awaiting an unfiltered delete executes soft-delete-all, no silent no-op", async () => {
    // Thenable set-chain, like Drizzle's real QueryPromise builders.
    const executions: string[] = [];
    const chain = {
      where: vi.fn(() => chain),
      // oxlint-disable-next-line no-thenable -- intentionally thenable mock
      then: (onFulfilled?: (v: unknown) => unknown) =>
        Promise.resolve("executed").then((v) => {
          executions.push("run");
          return onFulfilled ? onFulfilled(v) : v;
        }),
    };
    const set = vi.fn(() => chain);
    const db = {
      delete: vi.fn(),
      update: vi.fn(() => ({ set })),
    };

    const auditedDb = createAuditedDb(db, { softDeleteTables: ["users"] });

    const result = await auditedDb.delete(usersWithSoftDelete);

    // The statement executed (Drizzle delete-all semantics preserved as
    // soft-delete-all); previously this resolved to a dead {where} object.
    expect(executions).toEqual(["run"]);
    expect(result).toBe("executed");
    expect(set).toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  test("deletes inside transactions are converted", async () => {
    const { db, updateSpy, mockUpdateWithSet } = createMockDb();
    const txDb = {
      ...db,
      transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(db)),
    };

    const auditedDb = createAuditedDb(txDb, { softDeleteTables: ["users"] });

    await auditedDb.transaction(async (tx) => {
      (tx as typeof auditedDb).delete(usersWithSoftDelete).where({ id: "user-123" });
    });

    expect(updateSpy).toHaveBeenCalledWith(usersWithSoftDelete);
    expect(mockUpdateWithSet.set).toHaveBeenCalled();
  });

  test("no config refuses at the first delete with a named error", () => {
    const { db, deleteSpy, updateSpy } = createMockDb();

    // An untyped caller: the required config is missing entirely.
    const auditedDb = createAuditedDb(db, undefined as unknown as AuditedDbConfig);

    expect(() => auditedDb.delete(usersWithSoftDelete)).toThrow(MissingSoftDeleteTablesError);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test("config without softDeleteTables refuses even for tables without deletedAt", () => {
    const { db, deleteSpy, updateSpy } = createMockDb();

    const auditedDb = createAuditedDb(db, {
      hardDeleteTables: ["session"],
    } as unknown as AuditedDbConfig);

    expect(() => auditedDb.delete(logsWithoutSoftDelete)).toThrow(MissingSoftDeleteTablesError);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test("a table with deletedAt is not converted unless listed", () => {
    const { db, deleteSpy, updateSpy } = createMockDb();

    const auditedDb = createAuditedDb(db, { softDeleteTables: [] });

    auditedDb.delete(usersWithSoftDelete).where({ id: "u1" });

    expect(deleteSpy).toHaveBeenCalledWith(usersWithSoftDelete);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test("allowlist mode: listed table converts, unlisted hard-deletes", () => {
    const { db, deleteSpy, updateSpy } = createMockDb();

    const auditedDb = createAuditedDb(db, { softDeleteTables: ["users"] });

    auditedDb.delete(usersWithSoftDelete).where({ id: "u1" });
    expect(updateSpy).toHaveBeenCalledWith(usersWithSoftDelete);

    // logs has no deletedAt AND is unlisted: hard delete, no throw
    auditedDb.delete(logsWithoutSoftDelete).where({ id: "l1" });
    expect(deleteSpy).toHaveBeenCalledWith(logsWithoutSoftDelete);
  });

  test("allowlist mode: listed table without deletedAt throws instead of hard-deleting", () => {
    const { db, deleteSpy } = createMockDb();

    const auditedDb = createAuditedDb(db, { softDeleteTables: ["logs"] });

    expect(() => auditedDb.delete(logsWithoutSoftDelete)).toThrow(MissingSoftDeleteColumnError);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test("catch-swallowed rejection never writes a false SOFT_DELETE entry", async () => {
    const entries: unknown[] = [];
    // Mirrors Drizzle's QueryPromise: catch delegates to this.then on
    // the raw builder, and execute() rejects.
    const chain: Record<string, unknown> = {};
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => chain);
    // oxlint-disable-next-line no-thenable -- intentionally thenable mock
    chain.then = function (
      this: unknown,
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) {
      return Promise.reject(new Error("D1 exploded")).then(onFulfilled, onRejected);
    };
    chain.catch = function (
      this: { then: (f?: unknown, r?: unknown) => unknown },
      onRejected?: (e: unknown) => unknown,
    ) {
      return this.then(undefined, onRejected);
    };
    const db = {
      delete: vi.fn(),
      update: vi.fn(() => ({ set: vi.fn(() => chain) })),
    };

    const auditedDb = createAuditedDb(db, {
      softDeleteTables: ["users"],
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const swallowed = await auditedDb
      .delete(usersWithSoftDelete)
      .where({ id: "u1" })
      .catch(() => "caught");

    expect(swallowed).toBe("caught");
    await new Promise((r) => setTimeout(r, 0));

    // The statement never executed successfully -- no entry
    expect(entries).toHaveLength(0);
  });

  test("allowlist mode throws on an unresolvable table name instead of hard-deleting", () => {
    const { db, deleteSpy } = createMockDb();

    const auditedDb = createAuditedDb(db, { softDeleteTables: ["users"] });

    // A table-like object with columns but no resolvable drizzle name
    const anonymousTable = { id: { name: "id" }, deletedAt: { name: "deleted_at" } };

    expect(() => auditedDb.delete(anonymousTable)).toThrow(UnresolvedSoftDeleteTableError);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test("no audit entry for a statement that is never executed", async () => {
    const entries: AuditLogEntry[] = [];
    const chain = {
      where: vi.fn(() => chain),
      returning: vi.fn(() => chain),
      // oxlint-disable-next-line no-thenable -- intentionally thenable mock
      then: (onFulfilled?: (v: unknown) => unknown) =>
        Promise.resolve(undefined).then((v) => (onFulfilled ? onFulfilled(v) : v)),
    };
    const db = {
      delete: vi.fn(),
      update: vi.fn(() => ({ set: vi.fn(() => chain) })),
    };

    const auditedDb = createAuditedDb(db, {
      softDeleteTables: ["users"],
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    // Built but never awaited/executed
    auditedDb.delete(usersWithSoftDelete).where({ id: "u1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(entries).toHaveLength(0);
  });
});

// Drizzle's sqlite-proxy driver over node:sqlite: real Drizzle builders
// executing real SQL, so the audit path is exercised end to end.
type ProxyMethod = "run" | "all" | "values" | "get";

function createSqliteDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, deleted_at INTEGER, deleted_by TEXT);
    CREATE TABLE memberships (
      org_id TEXT NOT NULL, user_id TEXT NOT NULL, deleted_at INTEGER, deleted_by TEXT,
      PRIMARY KEY (org_id, user_id)
    );
    CREATE TABLE notes (body TEXT, deleted_at INTEGER, deleted_by TEXT);
  `);
  const query = (sqlText: string, params: unknown[], method: ProxyMethod) => {
    const statement = raw.prepare(sqlText);
    const args = params as SQLInputValue[];
    if (method === "run") {
      statement.run(...args);
      return { rows: [] };
    }
    statement.setReturnArrays(true);
    const rows = statement.all(...args) as unknown[];
    return { rows: method === "get" ? rows[0] : rows };
  };
  const db = drizzle(
    async (sqlText, params, method) => query(sqlText, params, method),
    async (queries) => queries.map((q) => query(q.sql, q.params, q.method)),
  );
  return { raw, db };
}

const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  deletedBy: text("deleted_by"),
});

const memberships = sqliteTable(
  "memberships",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    deletedBy: text("deleted_by"),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

const notes = sqliteTable("notes", {
  body: text("body"),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  deletedBy: text("deleted_by"),
});

function auditedSqlite() {
  const { raw, db } = createSqliteDb();
  raw.exec(`INSERT INTO users (id, name) VALUES ('u1', 'Ada'), ('u2', 'Bo'), ('u3', 'Cy')`);
  const entries: AuditLogEntry[] = [];
  const audited = createAuditedDb(db, {
    softDeleteTables: ["users", "memberships", "notes"],
    writeAuditEntry: (entry) => {
      entries.push(entry);
      return Promise.resolve();
    },
  });
  const deletedIds = () =>
    raw
      .prepare("SELECT id FROM users WHERE deleted_at IS NOT NULL ORDER BY id")
      .all()
      .map((row) => row.id);
  return { raw, audited, entries, deletedIds };
}

// Let the fire-and-forget audit writes settle.
const settled = () => new Promise((r) => setTimeout(r, 0));

describe("createAuditedDb soft-delete audit entries (real SQLite)", () => {
  test("a delete by id writes one SOFT_DELETE entry carrying that id", async () => {
    const { audited, entries, deletedIds } = auditedSqlite();

    await audited.delete(users).where(eq(users.id, "u2"));
    await settled();

    expect(deletedIds()).toEqual(["u2"]);
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("SOFT_DELETE");
    expect(entries[0].tableName).toBe("users");
    expect(entries[0].recordId).toBe("u2");
    expect(entries[0].newData?.deletedAt).toBeInstanceOf(Date);
  });

  test("a delete matching no rows writes no entry", async () => {
    const { audited, entries, deletedIds } = auditedSqlite();

    await audited.delete(users).where(eq(users.id, "nobody"));
    await settled();

    expect(deletedIds()).toEqual([]);
    expect(entries).toHaveLength(0);
  });

  test("a multi-row delete writes one entry per affected row", async () => {
    const { audited, entries } = auditedSqlite();

    await audited.delete(users);
    await settled();

    expect(entries.map((e) => e.recordId).sort()).toEqual(["u1", "u2", "u3"]);
  });

  test("execute(), all() and get() record every affected row", async () => {
    const executed = auditedSqlite();
    await executed.audited.delete(users).where(eq(users.id, "u1")).execute();
    await settled();
    expect(executed.entries.map((e) => e.recordId)).toEqual(["u1"]);

    const listed = auditedSqlite();
    await listed.audited.delete(users).where(eq(users.id, "u3")).all();
    await settled();
    expect(listed.entries.map((e) => e.recordId)).toEqual(["u3"]);

    const first = auditedSqlite();
    const row = await first.audited.delete(users).get();
    await settled();
    expect(row).toEqual({ id: expect.any(String) });
    expect(first.entries.map((e) => e.recordId).sort()).toEqual(["u1", "u2", "u3"]);
  });

  test("the caller's returning() rows come back unchanged", async () => {
    const full = auditedSqlite();
    const rows = await full.audited.delete(users).where(eq(users.id, "u1")).returning();
    await settled();
    expect(rows).toEqual([{ id: "u1", name: "Ada", deletedAt: expect.any(Date), deletedBy: null }]);
    expect(full.entries.map((e) => e.recordId)).toEqual(["u1"]);

    const partial = auditedSqlite();
    const names = await partial.audited
      .delete(users)
      .where(eq(users.id, "u2"))
      .returning({ name: users.name });
    await settled();
    expect(names).toEqual([{ name: "Bo" }]);
    expect(partial.entries.map((e) => e.recordId)).toEqual(["u2"]);
  });

  test("finally() records the affected row ids and hides the added keys", async () => {
    const plain = auditedSqlite();
    let ran = 0;
    const keyRows = await plain.audited
      .delete(users)
      .where(eq(users.id, "u1"))
      .finally(() => {
        ran += 1;
      });
    await settled();
    expect(ran).toBe(1);
    expect(plain.deletedIds()).toEqual(["u1"]);
    expect(keyRows).toEqual([{ id: "u1" }]);
    expect(plain.entries.map((e) => e.recordId)).toEqual(["u1"]);

    const selected = auditedSqlite();
    const names = await selected.audited
      .delete(users)
      .where(eq(users.id, "u2"))
      .returning({ name: users.name })
      .finally(() => {});
    await settled();
    expect(names).toEqual([{ name: "Bo" }]);
    expect(selected.entries.map((e) => e.recordId)).toEqual(["u2"]);
  });

  test("without a caller returning(), the delete resolves to the affected keys", async () => {
    const { audited } = auditedSqlite();

    const result = await audited.delete(users).where(eq(users.id, "u1"));

    expect(result).toEqual([{ id: "u1" }]);
  });

  test("run() records the affected row ids and resolves to the rows", async () => {
    const { audited, entries, deletedIds } = auditedSqlite();

    const result = await audited.delete(users).where(eq(users.id, "u1")).run();
    await settled();

    expect(deletedIds()).toEqual(["u1"]);
    expect(result).toEqual([{ id: "u1" }]);
    expect(entries.map((e) => e.recordId)).toEqual(["u1"]);
  });

  test("run() matching no rows writes no entry", async () => {
    const { audited, entries, deletedIds } = auditedSqlite();

    await audited.delete(users).where(eq(users.id, "nobody")).run();
    await settled();

    expect(deletedIds()).toEqual([]);
    expect(entries).toHaveLength(0);
  });

  test("a result naming no rows writes nothing when the driver reports zero affected", async () => {
    const executeWith = async (result: unknown) => {
      const entries: AuditLogEntry[] = [];
      const db = {
        update: () => ({
          set: () => ({ returning: () => ({ execute: () => Promise.resolve(result) }) }),
        }),
      };
      const audited = createAuditedDb(db, {
        softDeleteTables: ["users"],
        writeAuditEntry: (entry) => {
          entries.push(entry);
          return Promise.resolve();
        },
      });
      await audited.delete(users).execute();
      await settled();
      return entries.map((e) => e.recordId);
    };

    expect(await executeWith({ changes: 0 })).toEqual([]);
    expect(await executeWith({ meta: { changes: 0 } })).toEqual([]);
    expect(await executeWith({ rowsAffected: 2 })).toEqual(["unknown"]);
    expect(await executeWith(undefined)).toEqual(["unknown"]);
  });

  test("values() records the affected row ids and hides the added keys", async () => {
    const keysOnly = auditedSqlite();
    const keyRows = await keysOnly.audited.delete(users).where(eq(users.id, "u1")).values();
    await settled();
    expect(keyRows).toEqual([["u1"]]);
    expect(keysOnly.entries.map((e) => e.recordId)).toEqual(["u1"]);

    const selected = auditedSqlite();
    const nameRows = await selected.audited
      .delete(users)
      .where(eq(users.id, "u2"))
      .returning({ name: users.name })
      .values();
    await settled();
    expect(nameRows).toEqual([["Bo"]]);
    expect(selected.entries.map((e) => e.recordId)).toEqual(["u2"]);

    const none = auditedSqlite();
    await none.audited.delete(users).where(eq(users.id, "nobody")).values();
    await settled();
    expect(none.entries).toHaveLength(0);
  });

  test("batch members record their own row ids", async () => {
    const { audited, entries, deletedIds } = auditedSqlite();

    const results = await audited.batch([
      audited.delete(users).where(eq(users.id, "u1")),
      audited.delete(users).where(eq(users.id, "nobody")),
      audited.delete(users).where(eq(users.id, "u3")).returning({ name: users.name }),
    ]);
    await settled();

    expect(deletedIds()).toEqual(["u1", "u3"]);
    expect(entries.map((e) => e.recordId)).toEqual(["u1", "u3"]);
    expect(results).toEqual([[{ id: "u1" }], [], [{ name: "Cy" }]]);
  });

  test("a prepared statement executed twice writes entries for both executions", async () => {
    const { audited, entries, deletedIds } = auditedSqlite();

    const prepared = audited
      .delete(users)
      .where(eq(users.id, sql.placeholder("id")))
      .prepare();
    await prepared.execute({ id: "u1" });
    await prepared.execute({ id: "u2" });
    await settled();

    expect(deletedIds()).toEqual(["u1", "u2"]);
    expect(entries.map((e) => e.recordId)).toEqual(["u1", "u2"]);
  });

  test("a builder awaited twice writes entries for each execution", async () => {
    const { audited, entries } = auditedSqlite();

    const statement = audited.delete(users).where(eq(users.id, "u1"));
    await statement;
    await statement;
    await settled();

    expect(entries.map((e) => e.recordId)).toEqual(["u1", "u1"]);
  });

  test("a composite primary key serializes as a JSON array record id", async () => {
    const { raw, audited, entries } = auditedSqlite();
    raw.exec(`INSERT INTO memberships (org_id, user_id) VALUES ('o1', 'u1'), ('o1', 'u2')`);

    await audited.delete(memberships).where(eq(memberships.userId, "u2"));
    await settled();

    expect(entries.map((e) => e.recordId)).toEqual([JSON.stringify(["o1", "u2"])]);
  });

  test("auditing a table with no primary key throws a named error", () => {
    const { audited } = auditedSqlite();

    expect(() => audited.delete(notes)).toThrow(MissingPrimaryKeyError);
  });
});

describe("createAuditedDb soft-delete audit entries without RETURNING (MySQL)", () => {
  test("pre-selects the matching keys and writes one entry per row", async () => {
    const order: string[] = [];
    const entries: AuditLogEntry[] = [];
    const condition = { kind: "where" };
    const selectWhere = vi.fn(async () => {
      order.push("select");
      return [{ __ledger_pk_0: "u1" }, { __ledger_pk_0: "u2" }];
    });
    const from = vi.fn(() => ({ where: selectWhere }));
    const select = vi.fn(() => ({ from }));
    const updateBuilder: Record<string, unknown> = { config: {} as Record<string, unknown> };
    updateBuilder.where = vi.fn((w: unknown) => {
      (updateBuilder.config as Record<string, unknown>).where = w;
      return updateBuilder;
    });
    updateBuilder.execute = vi.fn(async () => {
      order.push("update");
      return [{ affectedRows: 2 }];
    });
    const db = {
      delete: vi.fn(),
      select,
      update: vi.fn(() => ({ set: vi.fn(() => updateBuilder) })),
    };

    const audited = createAuditedDb(db, {
      softDeleteTables: ["users"],
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const result = await audited.delete(usersWithSoftDelete).where(condition).execute();
    await settled();

    expect(order).toEqual(["select", "update"]);
    expect(selectWhere).toHaveBeenCalledWith(condition);
    expect(result).toEqual([{ affectedRows: 2 }]);
    expect(entries.map((e) => e.recordId)).toEqual(["u1", "u2"]);
  });

  test("a pre-select that finds nothing writes no entry", async () => {
    const entries: AuditLogEntry[] = [];
    const updateBuilder: Record<string, unknown> = { config: {} };
    updateBuilder.where = vi.fn(() => updateBuilder);
    updateBuilder.execute = vi.fn(async () => [{ affectedRows: 0 }]);
    const db = {
      delete: vi.fn(),
      select: vi.fn(() => ({ from: () => ({ where: async () => [] }) })),
      update: vi.fn(() => ({ set: vi.fn(() => updateBuilder) })),
    };

    const audited = createAuditedDb(db, {
      softDeleteTables: ["users"],
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    await audited.delete(usersWithSoftDelete).where({}).execute();
    await settled();

    expect(entries).toHaveLength(0);
  });
});
