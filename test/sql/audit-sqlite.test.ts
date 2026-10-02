import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { uuidv7 } from "uuidv7";
import { beforeEach, describe, expect, it } from "vitest";

const AUDIT_SQL = readFileSync(new URL("../../sql/sqlite/audit.sql", import.meta.url), "utf8");

function insertEntry(
  db: DatabaseSync,
  overrides: { action?: string; changedFields?: string } = {},
) {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO ledger_audit (id, table_name, record_id, action, changed_fields, user_id, ip, user_agent, endpoint, request_id, created_at)
     VALUES (?, 'users', 'rec-1', ?, ?, 'u-1', '1.2.3.4', 'ua', 'POST /users', 'req-1', 1700000000000)`,
  ).run(id, overrides.action ?? "UPDATE", overrides.changedFields ?? '["name","email"]');
  return id;
}

describe("ledger_audit SQLite migration", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(AUDIT_SQL);
  });

  it("accepts an INSERT and returns the stored row", () => {
    const id = insertEntry(db);
    const row = db.prepare("SELECT * FROM ledger_audit WHERE id = ?").get(id);
    expect(row).toMatchObject({
      id,
      table_name: "users",
      record_id: "rec-1",
      action: "UPDATE",
      changed_fields: '["name","email"]',
      user_id: "u-1",
      created_at: 1700000000000,
    });
  });

  it("has no column that could hold field values", () => {
    const columns = db
      .prepare("PRAGMA table_info(ledger_audit)")
      .all()
      .map((c) => String(c.name));
    expect(columns).toEqual([
      "id",
      "table_name",
      "record_id",
      "action",
      "changed_fields",
      "user_id",
      "ip",
      "user_agent",
      "endpoint",
      "request_id",
      "created_at",
    ]);
  });

  it("defaults created_at to integer milliseconds", () => {
    db.prepare(
      "INSERT INTO ledger_audit (id, table_name, record_id, action) VALUES (?, 't', 'r', 'INSERT')",
    ).run("a");
    const row = db.prepare("SELECT created_at FROM ledger_audit WHERE id = 'a'").get();
    expect(Number(row?.created_at)).toBeGreaterThan(1_600_000_000_000);
  });

  it("rejects an unknown action", () => {
    expect(() => insertEntry(db, { action: "RESTORE" })).toThrow(/CHECK/);
  });

  it("rejects changed_fields that is not a JSON array", () => {
    expect(() => insertEntry(db, { changedFields: '{"a":1}' })).toThrow(/CHECK/);
  });

  it("aborts an UPDATE of any column", () => {
    const id = insertEntry(db);
    expect(() => db.prepare("UPDATE ledger_audit SET user_id = NULL WHERE id = ?").run(id)).toThrow(
      /append-only/,
    );
  });

  it("aborts an UPDATE that matches every row", () => {
    insertEntry(db);
    expect(() => db.exec("UPDATE ledger_audit SET ip = NULL")).toThrow(/append-only/);
  });

  it("aborts a DELETE of one row", () => {
    const id = insertEntry(db);
    expect(() => db.prepare("DELETE FROM ledger_audit WHERE id = ?").run(id)).toThrow(
      /append-only/,
    );
  });

  it("aborts a DELETE of every row", () => {
    insertEntry(db);
    expect(() => db.exec("DELETE FROM ledger_audit")).toThrow(/append-only/);
  });

  it("aborts INSERT OR REPLACE over an existing id", () => {
    const id = insertEntry(db);
    expect(() =>
      db
        .prepare(
          "INSERT OR REPLACE INTO ledger_audit (id, table_name, record_id, action) VALUES (?, 't', 'r', 'INSERT')",
        )
        .run(id),
    ).toThrow(/append-only/);
    const row = db.prepare("SELECT table_name FROM ledger_audit WHERE id = ?").get(id);
    expect(row?.table_name).toBe("users");
  });

  it("applies cleanly twice", () => {
    expect(() => db.exec(AUDIT_SQL)).not.toThrow();
  });

  it("applies cleanly with the sqlite3 CLI", () => {
    let version: string;
    try {
      version = execFileSync("sqlite3", ["--version"], { encoding: "utf8" });
    } catch {
      return;
    }
    expect(version).toMatch(/^\d/);
    const out = execFileSync(
      "sqlite3",
      [
        ":memory:",
        ".read sql/sqlite/audit.sql",
        "INSERT INTO ledger_audit (id, table_name, record_id, action) VALUES ('a','t','r','INSERT');",
        "SELECT count(*) FROM ledger_audit;",
      ],
      { encoding: "utf8" },
    );
    expect(out.trim()).toBe("1");
  });
});
