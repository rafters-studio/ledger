import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
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

  test("writes a SOFT_DELETE audit entry once per executed statement", async () => {
    const entries: AuditLogEntry[] = [];
    const chain = {
      where: vi.fn(() => chain),
      returning: vi.fn(() => chain),
      // oxlint-disable-next-line no-thenable -- intentionally thenable mock
      then: (onFulfilled?: (v: unknown) => unknown) =>
        Promise.resolve([{ id: "u1" }]).then((v) => (onFulfilled ? onFulfilled(v) : v)),
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

    await auditedDb.delete(usersWithSoftDelete).where({ id: "u1" }).returning();
    // Allow the fire-and-forget audit write to settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("SOFT_DELETE");
    expect(entries[0].tableName).toBe("users");
    expect(entries[0].recordId).toBe("unknown");
    expect(entries[0].newData?.deletedAt).toBeInstanceOf(Date);
  });

  test("catch-swallowed rejection never writes a false SOFT_DELETE entry", async () => {
    const entries: unknown[] = [];
    // Mirrors Drizzle's QueryPromise: catch delegates to this.then on
    // the raw builder, and execute() rejects.
    const chain: Record<string, unknown> = {};
    chain.where = vi.fn(() => chain);
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

  test("batch-executed soft-deletes fire their audit entries", async () => {
    const entries: { action: string }[] = [];
    const chain: Record<string, unknown> = { kind: "statement" };
    chain.where = vi.fn(() => chain);
    const batchSpy = vi.fn().mockResolvedValue(["ok"]);
    const db = {
      delete: vi.fn(),
      update: vi.fn(() => ({ set: vi.fn(() => chain) })),
      batch: batchSpy,
    };

    const auditedDb = createAuditedDb(db, {
      softDeleteTables: ["users"],
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const stmt = auditedDb.delete(usersWithSoftDelete).where({ id: "u1" });
    const result = await auditedDb.batch([stmt]);

    expect(result).toEqual(["ok"]);
    expect(batchSpy).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));

    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("SOFT_DELETE");
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
