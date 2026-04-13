import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, test, vi } from "vitest";
import { createAuditedDb, getTableName, hasColumn } from "../../src/drizzle/db.js";
import { createLedgerContext, runWithLedgerContext } from "../../src/core/context.js";

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

  test("converts delete to soft-delete for tables with deletedAt", () => {
    const { db, updateSpy, mockUpdateWithSet, mockUpdateWithWhere } = createMockDb();

    const auditedDb = createAuditedDb(db);

    const result = auditedDb.delete(usersWithSoftDelete);
    result.where({ id: "user-123" });

    expect(updateSpy).toHaveBeenCalledWith(usersWithSoftDelete);
    expect(mockUpdateWithSet.set).toHaveBeenCalled();
    expect(mockUpdateWithWhere.where).toHaveBeenCalledWith({ id: "user-123" });

    const setCall = mockUpdateWithSet.set.mock.calls[0][0];
    expect(setCall.deletedAt).toBeInstanceOf(Date);
    expect(setCall.deletedBy).toBeNull();
  });

  test("uses regular delete for tables without deletedAt", () => {
    const { db, deleteSpy, updateSpy, mockDeleteWithWhere } = createMockDb();

    const auditedDb = createAuditedDb(db);

    auditedDb.delete(logsWithoutSoftDelete).where({ id: "log-123" });

    expect(deleteSpy).toHaveBeenCalledWith(logsWithoutSoftDelete);
    expect(mockDeleteWithWhere.where).toHaveBeenCalledWith({ id: "log-123" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test("respects hardDeleteTables config", () => {
    const { db, deleteSpy, updateSpy, mockDeleteWithWhere } = createMockDb();

    const auditedDb = createAuditedDb(db, {
      hardDeleteTables: ["users"],
    });

    auditedDb.delete(usersWithSoftDelete).where({ id: "user-123" });

    expect(deleteSpy).toHaveBeenCalledWith(usersWithSoftDelete);
    expect(mockDeleteWithWhere.where).toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test("captures userId from context for deletedBy", () => {
    const { db, mockUpdateWithSet } = createMockDb();

    const auditedDb = createAuditedDb(db);

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

    const auditedDb = createAuditedDb(db);

    const result = await auditedDb
      .delete(usersWithSoftDelete)
      .where({ id: "user-123" })
      .returning();

    expect(mockUpdateResult.returning).toHaveBeenCalled();
    expect(result).toEqual([{ id: "user-123", deletedAt: expect.any(Date) }]);
  });

  test("execute() works on soft-delete", async () => {
    const { db, mockUpdateResult } = createMockDb();

    const auditedDb = createAuditedDb(db);

    await auditedDb.delete(usersWithSoftDelete).where({ id: "user-123" }).execute();

    expect(mockUpdateResult.execute).toHaveBeenCalled();
  });
});
