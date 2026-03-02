import { describe, expect, test, vi } from "vitest";
import { anonymizeJsonData, isUserDataPurged, purgeUserData } from "../src/gdpr.js";

describe("anonymizeJsonData", () => {
  test("removes specified PII fields", () => {
    const data = { id: "123", email: "test@test.com", name: "John", role: "admin" };
    const result = anonymizeJsonData(data, ["email", "name"]);

    expect(result).toEqual({ id: "123", role: "admin" });
  });

  test("handles null input", () => {
    expect(anonymizeJsonData(null, ["email"])).toBeNull();
  });

  test("handles nested objects", () => {
    const data = { user: { email: "test@test.com", id: "123" } };
    const result = anonymizeJsonData(data, ["email"]);

    expect(result).toEqual({ user: { id: "123" } });
  });

  test("handles deeply nested objects", () => {
    const data = {
      level1: {
        level2: {
          email: "deep@test.com",
          keepMe: "value",
        },
      },
    };
    const result = anonymizeJsonData(data, ["email"]);

    expect(result).toEqual({
      level1: {
        level2: {
          keepMe: "value",
        },
      },
    });
  });

  test("handles arrays of objects", () => {
    const data = {
      users: [
        { id: "1", email: "a@test.com" },
        { id: "2", email: "b@test.com" },
      ],
    };
    const result = anonymizeJsonData(data, ["email"]);

    expect(result).toEqual({
      users: [{ id: "1" }, { id: "2" }],
    });
  });

  test("handles arrays of primitives", () => {
    const data = { tags: ["tag1", "tag2"], email: "remove@test.com" };
    const result = anonymizeJsonData(data, ["email"]);

    expect(result).toEqual({ tags: ["tag1", "tag2"] });
  });

  test("handles empty object", () => {
    expect(anonymizeJsonData({}, ["email"])).toEqual({});
  });

  test("preserves non-PII fields", () => {
    const data = {
      id: "user-123",
      createdAt: "2024-01-01",
      role: "admin",
      email: "remove@test.com",
    };
    const result = anonymizeJsonData(data, ["email"]);

    expect(result).toEqual({
      id: "user-123",
      createdAt: "2024-01-01",
      role: "admin",
    });
  });

  test("handles mixed nested and top-level PII", () => {
    const data = {
      email: "top@test.com",
      profile: {
        name: "John",
        address: "123 Street",
        settings: {
          phone: "555-1234",
          theme: "dark",
        },
      },
    };
    const result = anonymizeJsonData(data, ["email", "name", "address", "phone"]);

    expect(result).toEqual({
      profile: {
        settings: {
          theme: "dark",
        },
      },
    });
  });
});

describe("purgeUserData", () => {
  test("anonymizes audit entries for user", async () => {
    const mockEntries = [
      {
        id: "entry-1",
        tableName: "users",
        recordId: "user-123",
        action: "UPDATE",
        oldData: JSON.stringify({ email: "old@test.com", id: "user-123" }),
        newData: JSON.stringify({ email: "new@test.com", id: "user-123" }),
        userId: "user-123",
        ip: "1.2.3.4",
        userAgent: "Mozilla/5.0",
        createdAt: new Date(),
      },
    ];

    const updatedValues: Record<string, unknown>[] = [];
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(mockEntries),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          updatedValues.push(values);
          return {
            where: vi.fn().mockResolvedValue(undefined),
          };
        }),
      }),
    };

    const mockAuditTable = {
      id: { name: "id" },
      userId: { name: "user_id" },
      recordId: { name: "record_id" },
    };

    const result = await purgeUserData(
      mockDb as unknown as Parameters<typeof purgeUserData>[0],
      mockAuditTable as unknown as Parameters<typeof purgeUserData>[1],
      "user-123",
      { piiFields: ["email", "name", "ip"] },
    );

    expect(result.entriesAnonymized).toBe(1);
    expect(result.tablesProcessed).toEqual(["users"]);

    // Verify anonymization
    expect(updatedValues).toHaveLength(1);
    expect(updatedValues[0].userId).toBe("PURGED_USER");
    expect(updatedValues[0].ip).toBeNull();
    expect(updatedValues[0].userAgent).toBeNull();

    // Verify JSON data was anonymized
    const oldData = JSON.parse(updatedValues[0].oldData as string);
    const newData = JSON.parse(updatedValues[0].newData as string);
    expect(oldData.email).toBeUndefined();
    expect(oldData.id).toBe("user-123");
    expect(newData.email).toBeUndefined();
    expect(newData.id).toBe("user-123");
  });

  test("preserves audit trail structure", async () => {
    const mockEntries = [
      {
        id: "entry-1",
        tableName: "users",
        recordId: "user-123",
        action: "UPDATE",
        oldData: JSON.stringify({ email: "test@test.com" }),
        newData: null,
        userId: "user-123",
        ip: "1.2.3.4",
        userAgent: "Mozilla/5.0",
        createdAt: new Date(),
      },
    ];

    const updatedValues: Record<string, unknown>[] = [];
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(mockEntries),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          updatedValues.push(values);
          return {
            where: vi.fn().mockResolvedValue(undefined),
          };
        }),
      }),
    };

    const mockAuditTable = {
      id: { name: "id" },
      userId: { name: "user_id" },
      recordId: { name: "record_id" },
    };

    await purgeUserData(
      mockDb as unknown as Parameters<typeof purgeUserData>[0],
      mockAuditTable as unknown as Parameters<typeof purgeUserData>[1],
      "user-123",
    );

    // Verify null newData is preserved as null
    expect(updatedValues[0].newData).toBeNull();
  });

  test("returns zero when no entries found", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
      update: vi.fn(),
    };

    const mockAuditTable = {
      id: { name: "id" },
      userId: { name: "user_id" },
      recordId: { name: "record_id" },
    };

    const result = await purgeUserData(
      mockDb as unknown as Parameters<typeof purgeUserData>[0],
      mockAuditTable as unknown as Parameters<typeof purgeUserData>[1],
      "nonexistent-user",
    );

    expect(result.entriesAnonymized).toBe(0);
    expect(result.tablesProcessed).toEqual([]);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  test("handles multiple entries across tables", async () => {
    const mockEntries = [
      {
        id: "entry-1",
        tableName: "users",
        recordId: "user-123",
        action: "INSERT",
        oldData: null,
        newData: JSON.stringify({ email: "test@test.com" }),
        userId: "user-123",
        ip: "1.1.1.1",
        userAgent: "UA1",
        createdAt: new Date(),
      },
      {
        id: "entry-2",
        tableName: "accounts",
        recordId: "acc-456",
        action: "INSERT",
        oldData: null,
        newData: JSON.stringify({ provider: "discord" }),
        userId: "user-123",
        ip: "2.2.2.2",
        userAgent: "UA2",
        createdAt: new Date(),
      },
      {
        id: "entry-3",
        tableName: "users",
        recordId: "user-123",
        action: "UPDATE",
        oldData: JSON.stringify({ name: "Old" }),
        newData: JSON.stringify({ name: "New" }),
        userId: "user-123",
        ip: "3.3.3.3",
        userAgent: "UA3",
        createdAt: new Date(),
      },
    ];

    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(mockEntries),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };

    const mockAuditTable = {
      id: { name: "id" },
      userId: { name: "user_id" },
      recordId: { name: "record_id" },
    };

    const result = await purgeUserData(
      mockDb as unknown as Parameters<typeof purgeUserData>[0],
      mockAuditTable as unknown as Parameters<typeof purgeUserData>[1],
      "user-123",
    );

    expect(result.entriesAnonymized).toBe(3);
    expect(result.tablesProcessed.sort()).toEqual(["accounts", "users"]);
  });

  test("uses custom anonymizedUserId", async () => {
    const mockEntries = [
      {
        id: "entry-1",
        tableName: "users",
        recordId: "user-123",
        action: "UPDATE",
        oldData: null,
        newData: null,
        userId: "user-123",
        ip: "1.2.3.4",
        userAgent: "UA",
        createdAt: new Date(),
      },
    ];

    const updatedValues: Record<string, unknown>[] = [];
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(mockEntries),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          updatedValues.push(values);
          return {
            where: vi.fn().mockResolvedValue(undefined),
          };
        }),
      }),
    };

    const mockAuditTable = {
      id: { name: "id" },
      userId: { name: "user_id" },
      recordId: { name: "record_id" },
    };

    await purgeUserData(
      mockDb as unknown as Parameters<typeof purgeUserData>[0],
      mockAuditTable as unknown as Parameters<typeof purgeUserData>[1],
      "user-123",
      { piiFields: [], anonymizedUserId: "DELETED_USER_123" },
    );

    expect(updatedValues[0].userId).toBe("DELETED_USER_123");
  });

  test("handles malformed JSON gracefully", async () => {
    const mockEntries = [
      {
        id: "entry-1",
        tableName: "users",
        recordId: "user-123",
        action: "UPDATE",
        oldData: "not valid json",
        newData: '{"valid": "json"}',
        userId: "user-123",
        ip: "1.2.3.4",
        userAgent: "UA",
        createdAt: new Date(),
      },
    ];

    const updatedValues: Record<string, unknown>[] = [];
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(mockEntries),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          updatedValues.push(values);
          return {
            where: vi.fn().mockResolvedValue(undefined),
          };
        }),
      }),
    };

    const mockAuditTable = {
      id: { name: "id" },
      userId: { name: "user_id" },
      recordId: { name: "record_id" },
    };

    // Should not throw
    const result = await purgeUserData(
      mockDb as unknown as Parameters<typeof purgeUserData>[0],
      mockAuditTable as unknown as Parameters<typeof purgeUserData>[1],
      "user-123",
    );

    expect(result.entriesAnonymized).toBe(1);
    // Malformed JSON results in null
    expect(updatedValues[0].oldData).toBeNull();
    // Valid JSON is anonymized
    expect(updatedValues[0].newData).toBe('{"valid":"json"}');
  });

  test("preserves userId for entries by other users about this user", async () => {
    const mockEntries = [
      {
        id: "entry-1",
        tableName: "users",
        recordId: "user-123", // This is about user-123
        action: "UPDATE",
        oldData: null,
        newData: null,
        userId: "admin-456", // But admin made the change
        ip: "1.2.3.4",
        userAgent: "UA",
        createdAt: new Date(),
      },
    ];

    const updatedValues: Record<string, unknown>[] = [];
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(mockEntries),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          updatedValues.push(values);
          return {
            where: vi.fn().mockResolvedValue(undefined),
          };
        }),
      }),
    };

    const mockAuditTable = {
      id: { name: "id" },
      userId: { name: "user_id" },
      recordId: { name: "record_id" },
    };

    await purgeUserData(
      mockDb as unknown as Parameters<typeof purgeUserData>[0],
      mockAuditTable as unknown as Parameters<typeof purgeUserData>[1],
      "user-123",
    );

    // Admin's userId, ip, and userAgent should be preserved since they're not the purged user
    expect(updatedValues[0].userId).toBe("admin-456");
    expect(updatedValues[0].ip).toBe("1.2.3.4");
    expect(updatedValues[0].userAgent).toBe("UA");
  });

  test("idempotent - safe to run multiple times", async () => {
    // First run
    const mockEntriesFirstRun = [
      {
        id: "entry-1",
        tableName: "users",
        recordId: "user-123",
        action: "UPDATE",
        oldData: JSON.stringify({ email: "test@test.com" }),
        newData: null,
        userId: "user-123",
        ip: "1.2.3.4",
        userAgent: "UA",
        createdAt: new Date(),
      },
    ];

    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(mockEntriesFirstRun),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };

    const mockAuditTable = {
      id: { name: "id" },
      userId: { name: "user_id" },
      recordId: { name: "record_id" },
    };

    // First purge
    const result1 = await purgeUserData(
      mockDb as unknown as Parameters<typeof purgeUserData>[0],
      mockAuditTable as unknown as Parameters<typeof purgeUserData>[1],
      "user-123",
    );

    expect(result1.entriesAnonymized).toBe(1);

    // Simulate second run where entries now have PURGED_USER
    const mockEntriesSecondRun = [
      {
        id: "entry-1",
        tableName: "users",
        recordId: "user-123",
        action: "UPDATE",
        oldData: JSON.stringify({ id: "user-123" }), // email already removed
        newData: null,
        userId: "PURGED_USER", // already anonymized
        ip: null, // already nullified
        userAgent: null, // already nullified
        createdAt: new Date(),
      },
    ];

    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(mockEntriesSecondRun),
      }),
    });

    // Second purge - should still work without error
    const result2 = await purgeUserData(
      mockDb as unknown as Parameters<typeof purgeUserData>[0],
      mockAuditTable as unknown as Parameters<typeof purgeUserData>[1],
      "user-123",
    );

    expect(result2.entriesAnonymized).toBe(1);
  });
});

describe("isUserDataPurged", () => {
  test("returns true when no entries exist for userId", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]), // Empty array = no entries
        }),
      }),
    };

    const mockAuditTable = {
      userId: { name: "user_id" },
    };

    const result = await isUserDataPurged(
      mockDb as unknown as Parameters<typeof isUserDataPurged>[0],
      mockAuditTable as unknown as Parameters<typeof isUserDataPurged>[1],
      "purged-user",
    );

    expect(result).toBe(true);
  });

  test("returns false when entries exist for userId", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "1" }, { id: "2" }]), // Non-empty = has entries
        }),
      }),
    };

    const mockAuditTable = {
      userId: { name: "user_id" },
    };

    const result = await isUserDataPurged(
      mockDb as unknown as Parameters<typeof isUserDataPurged>[0],
      mockAuditTable as unknown as Parameters<typeof isUserDataPurged>[1],
      "active-user",
    );

    expect(result).toBe(false);
  });
});
