import { describe, expect, test, vi } from "vitest";
import {
  createDeleteAuditCallback,
  createSoftDeleteCallback,
  isSoftDeletePerformed,
  type LedgerAuditEntry,
  ledgerPlugin,
  SoftDeletePerformedError,
} from "../src/better-auth.js";

describe("ledgerPlugin", () => {
  test("returns a valid BetterAuthPlugin", () => {
    const plugin = ledgerPlugin();

    expect(plugin.id).toBe("ledger");
    expect(plugin.init).toBeDefined();
    expect(typeof plugin.init).toBe("function");
  });

  test("init returns databaseHooks for audited tables", () => {
    const entries: LedgerAuditEntry[] = [];
    const plugin = ledgerPlugin({
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);

    expect(result?.options?.databaseHooks).toBeDefined();
    expect(result?.options?.databaseHooks?.user).toBeDefined();
    expect(result?.options?.databaseHooks?.account).toBeDefined();
  });

  test("databaseHooks for user create calls writeAuditEntry", async () => {
    const entries: LedgerAuditEntry[] = [];
    const plugin = ledgerPlugin({
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
    const userHooks = result?.options?.databaseHooks?.user;

    // Simulate user creation
    await userHooks?.create?.after?.({ id: "user-123", email: "test@test.com" });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tableName: "user",
      recordId: "user-123",
      action: "INSERT",
      oldData: null,
      userId: "user-123",
    });
    expect(entries[0]?.newData).toMatchObject({ id: "user-123", email: "test@test.com" });
  });

  test("databaseHooks for user update calls writeAuditEntry", async () => {
    const entries: LedgerAuditEntry[] = [];
    const plugin = ledgerPlugin({
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
    const userHooks = result?.options?.databaseHooks?.user;

    // Simulate user update
    await userHooks?.update?.after?.({ id: "user-456", email: "updated@test.com" });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tableName: "user",
      recordId: "user-456",
      action: "UPDATE",
      oldData: null,
      userId: "user-456",
    });
  });

  test("databaseHooks for account calls writeAuditEntry", async () => {
    const entries: LedgerAuditEntry[] = [];
    const plugin = ledgerPlugin({
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
    const accountHooks = result?.options?.databaseHooks?.account;

    // Simulate account creation
    await accountHooks?.create?.after?.({ id: "acc-123", userId: "user-123", provider: "discord" });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tableName: "account",
      recordId: "acc-123",
      action: "INSERT",
      userId: null, // account hooks don't have userId in the hook
    });
  });

  test("respects custom auditTables config", () => {
    const plugin = ledgerPlugin({
      auditTables: ["user", "session"],
    });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);

    expect(result?.options?.databaseHooks?.user).toBeDefined();
    expect(result?.options?.databaseHooks?.session).toBeDefined();
    expect(result?.options?.databaseHooks?.account).toBeUndefined();
  });

  test("does not include user delete hooks when softDeleteTables not configured", () => {
    const plugin = ledgerPlugin();

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);

    expect(result?.options?.user?.deleteUser).toBeUndefined();
  });

  test("includes user delete hooks when softDeleteTables contains user", async () => {
    const entries: LedgerAuditEntry[] = [];
    const plugin = ledgerPlugin({
      softDeleteTables: ["user"],
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);

    expect(result?.options?.user?.deleteUser?.beforeDelete).toBeDefined();

    // Call the beforeDelete hook
    await result?.options?.user?.deleteUser?.beforeDelete?.({
      id: "user-789",
      email: "deleted@test.com",
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tableName: "user",
      action: "SOFT_DELETE",
      recordId: "user-789",
    });
  });

  test("handles writeAuditEntry errors gracefully", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const plugin = ledgerPlugin({
      writeAuditEntry: () => {
        return Promise.reject(new Error("Database error"));
      },
    });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
    const userHooks = result?.options?.databaseHooks?.user;

    // Should not throw
    await expect(
      userHooks?.create?.after?.({ id: "user-123", email: "test@test.com" }),
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[ledger]"), expect.any(Error));

    consoleSpy.mockRestore();
  });

  test("works without writeAuditEntry (no-op)", async () => {
    const plugin = ledgerPlugin();

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
    const userHooks = result?.options?.databaseHooks?.user;

    // Should not throw
    await expect(
      userHooks?.create?.after?.({ id: "user-123", email: "test@test.com" }),
    ).resolves.toBeUndefined();
  });
});

describe("createSoftDeleteCallback", () => {
  test("performs soft-delete and throws", async () => {
    const mockUpdate = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const mockDb = { update: mockUpdate };
    const mockTable = {
      id: { equals: vi.fn() },
      deletedAt: {},
      deletedBy: {},
    };

    const callback = createSoftDeleteCallback({
      db: mockDb,
      userTable: mockTable,
      whereUserId: (userId) => ({ id: userId }),
    });

    const user = {
      id: "user-123",
      email: "test@test.com",
      name: "Test",
      createdAt: new Date(),
      updatedAt: new Date(),
      emailVerified: false,
      image: null,
    };

    await expect(callback(user)).rejects.toThrow("User soft-deleted successfully");

    // Verify soft-delete was called
    expect(mockUpdate).toHaveBeenCalledWith(mockTable);
    const setFn = mockUpdate.mock.results[0]?.value?.set;
    expect(setFn).toHaveBeenCalled();
    const setArg = setFn.mock.calls[0]?.[0];
    expect(setArg?.deletedAt).toBeInstanceOf(Date);
    expect(setArg?.deletedBy).toBeNull();
  });

  test("logs audit entry if provided", async () => {
    const entries: LedgerAuditEntry[] = [];
    const mockDb = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };

    const callback = createSoftDeleteCallback({
      db: mockDb,
      userTable: { id: {}, deletedAt: {}, deletedBy: {} },
      whereUserId: (userId) => ({ id: userId }),
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const user = {
      id: "user-456",
      email: "audit@test.com",
      name: "Audit",
      createdAt: new Date(),
      updatedAt: new Date(),
      emailVerified: false,
      image: null,
    };

    try {
      await callback(user);
    } catch {
      // Expected to throw
    }

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tableName: "user",
      recordId: "user-456",
      action: "SOFT_DELETE",
    });
  });

  test("throws SoftDeletePerformedError with correct properties", async () => {
    const mockDb = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };

    const callback = createSoftDeleteCallback({
      db: mockDb,
      userTable: { id: {}, deletedAt: {} },
      whereUserId: (userId) => ({ id: userId }),
    });

    const user = {
      id: "user-789",
      email: "props@test.com",
      name: "Props",
      createdAt: new Date(),
      updatedAt: new Date(),
      emailVerified: false,
      image: null,
    };

    try {
      await callback(user);
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SoftDeletePerformedError);
      expect((error as SoftDeletePerformedError).code).toBe("SOFT_DELETE_PERFORMED");
      expect((error as SoftDeletePerformedError).softDeleted).toBe(true);
      expect((error as SoftDeletePerformedError).userId).toBe("user-789");
    }
  });
});

describe("createDeleteAuditCallback", () => {
  test("logs audit entry without throwing", async () => {
    const entries: LedgerAuditEntry[] = [];

    const callback = createDeleteAuditCallback((entry) => {
      entries.push(entry);
      return Promise.resolve();
    });

    const user = {
      id: "user-123",
      email: "delete@test.com",
      name: "Delete",
      createdAt: new Date(),
      updatedAt: new Date(),
      emailVerified: false,
      image: null,
    };

    // Should not throw
    await expect(callback(user)).resolves.toBeUndefined();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tableName: "user",
      recordId: "user-123",
      action: "DELETE", // Hard delete action
      newData: null,
    });
  });

  test("handles errors gracefully", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const callback = createDeleteAuditCallback(() => {
      return Promise.reject(new Error("Audit failed"));
    });

    const user = {
      id: "user-456",
      email: "error@test.com",
      name: "Error",
      createdAt: new Date(),
      updatedAt: new Date(),
      emailVerified: false,
      image: null,
    };

    // Should not throw
    await expect(callback(user)).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[ledger]"), expect.any(Error));

    consoleSpy.mockRestore();
  });
});

describe("SoftDeletePerformedError", () => {
  test("has correct properties", () => {
    const error = new SoftDeletePerformedError("user-123");

    expect(error.name).toBe("SoftDeletePerformedError");
    expect(error.message).toBe("User soft-deleted successfully");
    expect(error.code).toBe("SOFT_DELETE_PERFORMED");
    expect(error.softDeleted).toBe(true);
    expect(error.userId).toBe("user-123");
  });
});

describe("isSoftDeletePerformed", () => {
  test("returns true for SoftDeletePerformedError", () => {
    const error = new SoftDeletePerformedError("user-123");
    expect(isSoftDeletePerformed(error)).toBe(true);
  });

  test("returns true for error with matching properties", () => {
    const error = new Error("User soft-deleted");
    (error as Error & { code: string }).code = "SOFT_DELETE_PERFORMED";
    (error as Error & { softDeleted: boolean }).softDeleted = true;

    expect(isSoftDeletePerformed(error)).toBe(true);
  });

  test("returns false for regular errors", () => {
    const error = new Error("Regular error");
    expect(isSoftDeletePerformed(error)).toBe(false);
  });

  test("returns false for errors with wrong code", () => {
    const error = new Error("Wrong code");
    (error as Error & { code: string }).code = "WRONG_CODE";
    (error as Error & { softDeleted: boolean }).softDeleted = true;

    expect(isSoftDeletePerformed(error)).toBe(false);
  });

  test("returns false for non-errors", () => {
    expect(isSoftDeletePerformed(null)).toBe(false);
    expect(isSoftDeletePerformed(undefined)).toBe(false);
    expect(isSoftDeletePerformed("string")).toBe(false);
    expect(isSoftDeletePerformed(123)).toBe(false);
    expect(isSoftDeletePerformed({})).toBe(false);
  });
});
