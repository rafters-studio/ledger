import { describe, expect, test, vi } from "vitest";
import { createLedgerContext, runWithLedgerContext } from "../../src/core/context.js";
import {
  type AuditEntryInput,
  AuditLogger,
  extractRecordId,
  parseQuery,
} from "../../src/drizzle/logger.js";

describe("parseQuery", () => {
  test("parses INSERT query", () => {
    const result = parseQuery("INSERT INTO users (id, name) VALUES (?, ?)");
    expect(result).toEqual({ action: "INSERT", table: "users" });
  });

  test("parses INSERT with backticks", () => {
    const result = parseQuery("INSERT INTO `users` (`id`) VALUES (?)");
    expect(result).toEqual({ action: "INSERT", table: "users" });
  });

  test("parses UPDATE query", () => {
    const result = parseQuery("UPDATE users SET name = ? WHERE id = ?");
    expect(result).toEqual({ action: "UPDATE", table: "users" });
  });

  test("parses DELETE query", () => {
    const result = parseQuery("DELETE FROM users WHERE id = ?");
    expect(result).toEqual({ action: "DELETE", table: "users" });
  });

  test("parses SELECT query", () => {
    const result = parseQuery("SELECT id, name FROM users WHERE id = ?");
    expect(result).toEqual({ action: "SELECT", table: "users" });
  });

  test("parses SELECT * query", () => {
    const result = parseQuery("SELECT * FROM mods WHERE slug = ?");
    expect(result).toEqual({ action: "SELECT", table: "mods" });
  });

  test("handles case insensitivity", () => {
    const result = parseQuery("insert into USERS (id) values (?)");
    expect(result).toEqual({ action: "INSERT", table: "users" });
  });

  test("returns null for unparseable query", () => {
    expect(parseQuery("PRAGMA table_info(users)")).toBeNull();
  });

  test("returns null for BEGIN/COMMIT", () => {
    expect(parseQuery("BEGIN")).toBeNull();
    expect(parseQuery("COMMIT")).toBeNull();
  });

  test("returns null for empty query", () => {
    expect(parseQuery("")).toBeNull();
  });
});

describe("extractRecordId", () => {
  test("extracts UUID from params", () => {
    const params = ["018f1234-5678-7abc-def0-123456789abc", "John"];
    expect(extractRecordId(params)).toBe("018f1234-5678-7abc-def0-123456789abc");
  });

  test("extracts simple ID from params", () => {
    const params = ["user-123", "John"];
    expect(extractRecordId(params)).toBe("user-123");
  });

  test("returns null for empty params", () => {
    expect(extractRecordId([])).toBeNull();
  });

  test("skips non-string params", () => {
    const params = [123, true, null, "user-456"];
    expect(extractRecordId(params)).toBe("user-456");
  });

  test("skips very long strings", () => {
    const longString = "a".repeat(200);
    const params = [longString, "user-789"];
    expect(extractRecordId(params)).toBe("user-789");
  });
});

describe("AuditLogger", () => {
  test("calls writeAuditEntry for INSERT", async () => {
    const entries: AuditEntryInput[] = [];
    const logger = new AuditLogger((entry) => {
      entries.push(entry);
      return Promise.resolve();
    });

    logger.logQuery("INSERT INTO users (id, name) VALUES (?, ?)", ["user-123", "John"]);

    // Let fire-and-forget complete
    await new Promise((r) => setTimeout(r, 10));

    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("INSERT");
    expect(entries[0].tableName).toBe("users");
    expect(entries[0].recordId).toBe("user-123");
  });

  test("calls writeAuditEntry for UPDATE", async () => {
    const entries: AuditEntryInput[] = [];
    const logger = new AuditLogger((entry) => {
      entries.push(entry);
      return Promise.resolve();
    });

    logger.logQuery("UPDATE users SET name = ? WHERE id = ?", ["Jane", "user-456"]);

    await new Promise((r) => setTimeout(r, 10));

    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("UPDATE");
    expect(entries[0].tableName).toBe("users");
  });

  test("calls writeAuditEntry for DELETE", async () => {
    const entries: AuditEntryInput[] = [];
    const logger = new AuditLogger((entry) => {
      entries.push(entry);
      return Promise.resolve();
    });

    logger.logQuery("DELETE FROM users WHERE id = ?", ["user-789"]);

    await new Promise((r) => setTimeout(r, 10));

    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("DELETE");
  });

  test("skips SELECT by default", async () => {
    const entries: AuditEntryInput[] = [];
    const logger = new AuditLogger((entry) => {
      entries.push(entry);
      return Promise.resolve();
    });

    logger.logQuery("SELECT * FROM users WHERE id = ?", ["user-123"]);

    await new Promise((r) => setTimeout(r, 10));

    expect(entries).toHaveLength(0);
  });

  test("logs SELECT when configured", async () => {
    const entries: AuditEntryInput[] = [];
    const logger = new AuditLogger(
      (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
      { logSelects: true },
    );

    logger.logQuery("SELECT * FROM users WHERE id = ?", ["user-123"]);

    await new Promise((r) => setTimeout(r, 10));

    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("SELECT");
  });

  test("skips excluded tables", async () => {
    const entries: AuditEntryInput[] = [];
    const logger = new AuditLogger(
      (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
      { excludeTables: ["audit_log", "session"] },
    );

    logger.logQuery("INSERT INTO audit_log (id) VALUES (?)", ["log-123"]);
    logger.logQuery("INSERT INTO session (id) VALUES (?)", ["sess-123"]);
    logger.logQuery("INSERT INTO users (id) VALUES (?)", ["user-123"]);

    await new Promise((r) => setTimeout(r, 10));

    expect(entries).toHaveLength(1);
    expect(entries[0].tableName).toBe("users");
  });

  test("only logs included tables when specified", async () => {
    const entries: AuditEntryInput[] = [];
    const logger = new AuditLogger(
      (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
      { includeTables: ["users", "mods"] },
    );

    logger.logQuery("INSERT INTO users (id) VALUES (?)", ["user-123"]);
    logger.logQuery("INSERT INTO mods (id) VALUES (?)", ["mod-123"]);
    logger.logQuery("INSERT INTO tags (id) VALUES (?)", ["tag-123"]);

    await new Promise((r) => setTimeout(r, 10));

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.tableName)).toEqual(["users", "mods"]);
  });

  test("captures context from AsyncLocalStorage", async () => {
    const entries: AuditEntryInput[] = [];
    const logger = new AuditLogger((entry) => {
      entries.push(entry);
      return Promise.resolve();
    });

    const context = createLedgerContext({
      userId: "user-999",
      ip: "1.2.3.4",
      userAgent: "TestAgent",
      endpoint: "POST /api/test",
      requestId: "req-abc",
    });

    await runWithLedgerContext(context, async () => {
      logger.logQuery("INSERT INTO users (id) VALUES (?)", ["user-123"]);
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].userId).toBe("user-999");
    expect(entries[0].ip).toBe("1.2.3.4");
    expect(entries[0].userAgent).toBe("TestAgent");
    expect(entries[0].endpoint).toBe("POST /api/test");
    expect(entries[0].requestId).toBe("req-abc");
  });

  test("handles writeAuditEntry errors gracefully", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = new AuditLogger(() => {
      return Promise.reject(new Error("DB connection failed"));
    });

    // Should not throw
    logger.logQuery("INSERT INTO users (id) VALUES (?)", ["user-123"]);

    await new Promise((r) => setTimeout(r, 10));

    expect(consoleSpy).toHaveBeenCalledWith(
      "[ledger] Failed to write audit entry:",
      expect.any(Error),
    );

    consoleSpy.mockRestore();
  });

  test("skips unparseable queries", async () => {
    const entries: AuditEntryInput[] = [];
    const logger = new AuditLogger((entry) => {
      entries.push(entry);
      return Promise.resolve();
    });

    logger.logQuery("PRAGMA table_info(users)", []);

    await new Promise((r) => setTimeout(r, 10));

    expect(entries).toHaveLength(0);
  });
});
