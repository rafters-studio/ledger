import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Kysely, sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLedgerContext, runWithLedgerContext } from "../../src/core/context.js";
import { LedgerNotReadyError, LedgerRawDeleteError, ledger } from "../../src/kysely/index.js";
import { nodeSqliteDialect } from "../helpers/node-sqlite-dialect.js";

const AUDIT_SQL = readFileSync(new URL("../../sql/sqlite/audit.sql", import.meta.url), "utf8");

interface Database {
  users: { id: string; name: string; email: string | null; deleted_at: number | null };
  posts: { id: number | null; title: string; deleted_at: number | null };
  tags: { id: string; label: string };
  memberships: { org_id: string; user_id: string; role: string };
  ledger_audit: Record<string, unknown>;
}

interface AuditRecord {
  table_name: string;
  record_id: string;
  action: string;
  changed_fields: string;
  user_id: string | null;
  ip: string | null;
  user_agent: string | null;
  endpoint: string | null;
  request_id: string | null;
}

function createRawDatabase(withAudit = true): DatabaseSync {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, deleted_at INTEGER);
    CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, deleted_at INTEGER);
    CREATE TABLE tags (id TEXT PRIMARY KEY, label TEXT NOT NULL);
    CREATE TABLE memberships (org_id TEXT, user_id TEXT, role TEXT, PRIMARY KEY (org_id, user_id));
  `);
  if (withAudit) raw.exec(AUDIT_SQL);
  return raw;
}

async function setup(withAudit = true) {
  const raw = createRawDatabase(withAudit);
  const dialect = nodeSqliteDialect(raw);
  const log = vi.fn();
  const plugin = ledger({ dialect, log });
  const db = new Kysely<Database>({ dialect, plugins: [plugin] });
  return { raw, db, plugin, log };
}

function audit(raw: DatabaseSync): AuditRecord[] {
  return raw.prepare("SELECT * FROM ledger_audit ORDER BY rowid").all() as unknown as AuditRecord[];
}

describe("ledger kysely plugin", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
    await ctx.plugin.ready();
  });

  describe("startup", () => {
    it("logs the soft-delete tables once, found by their deleted_at column", async () => {
      expect(ctx.log).toHaveBeenCalledTimes(1);
      expect(ctx.log).toHaveBeenCalledWith("[ledger] soft-delete tables: posts, users");
      expect(ctx.plugin.softDeleteTables()).toEqual(["posts", "users"]);
    });

    it("does not log again on later queries", async () => {
      await ctx.db
        .insertInto("users")
        .values({ id: uuidv7(), name: "a", email: null, deleted_at: null })
        .execute();
      await ctx.db.selectFrom("users").selectAll().execute();
      expect(ctx.log).toHaveBeenCalledTimes(1);
    });

    it("rejects ready() when the audit table is missing", async () => {
      const missing = await setup(false);
      await expect(missing.plugin.ready()).rejects.toThrow(/does not exist/);
    });

    it("refuses a write issued before the schema is read", async () => {
      const raw = createRawDatabase();
      const dialect = nodeSqliteDialect(raw);
      const db = new Kysely<Database>({ dialect, plugins: [ledger({ dialect, log: () => {} })] });
      await expect(
        db.insertInto("tags").values({ id: uuidv7(), label: "x" }).execute(),
      ).rejects.toBeInstanceOf(LedgerNotReadyError);
      expect(audit(raw)).toHaveLength(0);
    });

    it("refuses a write to a table created after startup until refresh()", async () => {
      ctx.raw.exec("CREATE TABLE late (id TEXT PRIMARY KEY)");
      const db = ctx.db as unknown as Kysely<{ late: { id: string } }>;
      await expect(db.insertInto("late").values({ id: "1" }).execute()).rejects.toThrow(
        /does not know table "late"/,
      );
      await ctx.plugin.refresh();
      await db.insertInto("late").values({ id: "1" }).execute();
      expect(audit(ctx.raw).map((e) => [e.table_name, e.record_id])).toEqual([["late", "1"]]);
    });
  });

  describe("DELETE on a table with deleted_at", () => {
    it("runs as an UPDATE that sets deleted_at and keeps the row", async () => {
      const id = uuidv7();
      await ctx.db
        .insertInto("users")
        .values({ id, name: "a", email: null, deleted_at: null })
        .execute();
      const before = Date.now();
      await ctx.db.deleteFrom("users").where("id", "=", id).execute();
      const row = await ctx.db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      expect(row.deleted_at).toBeGreaterThanOrEqual(before);
      expect(row.deleted_at).toBeLessThanOrEqual(Date.now());
    });

    it("records one SOFT_DELETE entry per affected row with the real primary key", async () => {
      const ids = [uuidv7(), uuidv7(), uuidv7()];
      await ctx.db
        .insertInto("users")
        .values(ids.map((id) => ({ id, name: "n", email: null, deleted_at: null })))
        .execute();
      ctx.raw.exec("DELETE FROM ledger_audit WHERE 0");
      const before = audit(ctx.raw).length;
      await ctx.db
        .deleteFrom("users")
        .where("id", "in", [ids[0] as string, ids[1] as string])
        .execute();
      const entries = audit(ctx.raw).slice(before);
      expect(entries.map((e) => e.record_id).sort()).toEqual([ids[0], ids[1]].sort());
      expect(entries.every((e) => e.action === "SOFT_DELETE" && e.table_name === "users")).toBe(
        true,
      );
      expect(entries.every((e) => e.changed_fields === '["deleted_at"]')).toBe(true);
    });

    it("reports the matched row count to the caller", async () => {
      const ids = [uuidv7(), uuidv7()];
      await ctx.db
        .insertInto("users")
        .values(ids.map((id) => ({ id, name: "n", email: null, deleted_at: null })))
        .execute();
      const result = await ctx.db.deleteFrom("users").executeTakeFirst();
      expect(result.numDeletedRows).toBe(2n);
    });

    it("works on an integer autoincrement key", async () => {
      await ctx.db
        .insertInto("posts")
        .values([
          { id: null, title: "a", deleted_at: null },
          { id: null, title: "b", deleted_at: null },
        ])
        .execute();
      await ctx.db.deleteFrom("posts").where("title", "=", "b").execute();
      const entries = audit(ctx.raw).filter((e) => e.action === "SOFT_DELETE");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.record_id).toBe("2");
      expect(await ctx.db.selectFrom("posts").select("id").execute()).toHaveLength(2);
    });

    it("records nothing when no row matches", async () => {
      const result = await ctx.db.deleteFrom("users").where("id", "=", "nope").executeTakeFirst();
      expect(result.numDeletedRows).toBe(0n);
      expect(audit(ctx.raw)).toHaveLength(0);
    });

    it("keeps the caller's returning columns and hides the plugin's", async () => {
      const id = uuidv7();
      await ctx.db
        .insertInto("users")
        .values({ id, name: "keep", email: null, deleted_at: null })
        .execute();
      const rows = await ctx.db
        .deleteFrom("users")
        .where("id", "=", id)
        .returning(["name"])
        .execute();
      expect(rows).toEqual([{ name: "keep" }]);
    });
  });

  describe("DELETE on a table without deleted_at", () => {
    it("executes as written and records one DELETE entry per affected row", async () => {
      const ids = [uuidv7(), uuidv7()];
      await ctx.db
        .insertInto("tags")
        .values(ids.map((id) => ({ id, label: "t" })))
        .execute();
      await ctx.db.deleteFrom("tags").execute();
      expect(await ctx.db.selectFrom("tags").selectAll().execute()).toHaveLength(0);
      const entries = audit(ctx.raw).filter((e) => e.action === "DELETE");
      expect(entries.map((e) => e.record_id).sort()).toEqual([...ids].sort());
      expect(entries.every((e) => e.table_name === "tags" && e.changed_fields === "[]")).toBe(true);
    });

    it("records nothing when no row matches", async () => {
      await ctx.db.deleteFrom("tags").where("id", "=", "nope").execute();
      expect(audit(ctx.raw)).toHaveLength(0);
    });
  });

  describe("INSERT", () => {
    it("records one INSERT entry per inserted row", async () => {
      const ids = [uuidv7(), uuidv7(), uuidv7()];
      await ctx.db
        .insertInto("users")
        .values(ids.map((id) => ({ id, name: "n", email: null, deleted_at: null })))
        .execute();
      const entries = audit(ctx.raw);
      expect(entries.map((e) => e.record_id)).toEqual(ids);
      expect(entries.every((e) => e.action === "INSERT" && e.table_name === "users")).toBe(true);
    });

    it("uses the generated key and keeps insertId for an autoincrement table", async () => {
      const result = await ctx.db
        .insertInto("posts")
        .values({ id: null, title: "x", deleted_at: null })
        .executeTakeFirst();
      expect(result.insertId).toBe(1n);
      expect(audit(ctx.raw)[0]?.record_id).toBe("1");
    });

    it("records a composite primary key as a JSON array", async () => {
      await ctx.db
        .insertInto("memberships")
        .values({ org_id: "o1", user_id: "u1", role: "admin" })
        .execute();
      expect(audit(ctx.raw)[0]?.record_id).toBe('["o1","u1"]');
    });

    it("records nothing for a row the insert skipped", async () => {
      const id = uuidv7();
      await ctx.db.insertInto("tags").values({ id, label: "a" }).execute();
      await ctx.db
        .insertInto("tags")
        .values({ id, label: "b" })
        .onConflict((oc) => oc.doNothing())
        .execute();
      expect(audit(ctx.raw)).toHaveLength(1);
    });

    it("writes many rows in chunks", async () => {
      const values = Array.from({ length: 25 }, () => ({ id: uuidv7(), label: "t" }));
      await ctx.db.insertInto("tags").values(values).execute();
      expect(audit(ctx.raw)).toHaveLength(25);
    });

    it("keeps the caller's returning columns", async () => {
      const id = uuidv7();
      const rows = await ctx.db
        .insertInto("tags")
        .values({ id, label: "r" })
        .returning(["label"])
        .execute();
      expect(rows).toEqual([{ label: "r" }]);
    });
  });

  describe("UPDATE", () => {
    it("records one UPDATE entry per affected row with the SET columns", async () => {
      const ids = [uuidv7(), uuidv7(), uuidv7()];
      await ctx.db
        .insertInto("users")
        .values(ids.map((id) => ({ id, name: "n", email: null, deleted_at: null })))
        .execute();
      const before = audit(ctx.raw).length;
      const result = await ctx.db
        .updateTable("users")
        .set({ name: "changed", email: "e@x.test" })
        .where("id", "in", [ids[0] as string, ids[2] as string])
        .executeTakeFirst();
      expect(result.numUpdatedRows).toBe(2n);
      const entries = audit(ctx.raw).slice(before);
      expect(entries.map((e) => e.record_id).sort()).toEqual([ids[0], ids[2]].sort());
      expect(entries.every((e) => e.action === "UPDATE")).toBe(true);
      expect(entries.every((e) => e.changed_fields === '["name","email"]')).toBe(true);
    });

    it("records the new key when the update changes the primary key", async () => {
      await ctx.db.insertInto("tags").values({ id: "old", label: "t" }).execute();
      await ctx.db.updateTable("tags").set({ id: "new" }).where("id", "=", "old").execute();
      expect(audit(ctx.raw).at(-1)).toMatchObject({ record_id: "new", changed_fields: '["id"]' });
    });

    it("records nothing when no row matches", async () => {
      const result = await ctx.db
        .updateTable("users")
        .set({ name: "x" })
        .where("id", "=", "nope")
        .executeTakeFirst();
      expect(result.numUpdatedRows).toBe(0n);
      expect(audit(ctx.raw)).toHaveLength(0);
    });
  });

  describe("transactions", () => {
    it("rolls the audit entries back with the change on SQLite", async () => {
      await expect(
        ctx.db.transaction().execute(async (trx) => {
          await trx.insertInto("tags").values({ id: uuidv7(), label: "t" }).execute();
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      expect(audit(ctx.raw)).toHaveLength(0);
      expect(await ctx.db.selectFrom("tags").selectAll().execute()).toHaveLength(0);
    });

    it("commits entries with the change", async () => {
      await ctx.db.transaction().execute(async (trx) => {
        await trx.insertInto("tags").values({ id: uuidv7(), label: "t" }).execute();
      });
      expect(audit(ctx.raw)).toHaveLength(1);
    });
  });

  describe("actor fields", () => {
    it("copies the ledger context onto the entry", async () => {
      await runWithLedgerContext(
        createLedgerContext({
          userId: "actor-1",
          ip: "203.0.113.9",
          userAgent: "test-agent",
          endpoint: "POST /tags",
          requestId: "req-9",
        }),
        () => ctx.db.insertInto("tags").values({ id: uuidv7(), label: "t" }).execute(),
      );
      expect(audit(ctx.raw)[0]).toMatchObject({
        user_id: "actor-1",
        ip: "203.0.113.9",
        user_agent: "test-agent",
        endpoint: "POST /tags",
        request_id: "req-9",
      });
    });

    it("leaves them null outside a context", async () => {
      await ctx.db.insertInto("tags").values({ id: uuidv7(), label: "t" }).execute();
      expect(audit(ctx.raw)[0]).toMatchObject({
        user_id: null,
        ip: null,
        user_agent: null,
        endpoint: null,
        request_id: null,
      });
    });
  });

  describe("the audit table itself", () => {
    it("is not audited and not rewritten", async () => {
      await ctx.db
        .insertInto("ledger_audit")
        .values({
          id: uuidv7(),
          table_name: "manual",
          record_id: "1",
          action: "INSERT",
          changed_fields: "[]",
        })
        .execute();
      expect(audit(ctx.raw).map((e) => e.table_name)).toEqual(["manual"]);
    });

    it("lets the database's own append-only error through on UPDATE and DELETE", async () => {
      await ctx.db.insertInto("tags").values({ id: uuidv7(), label: "t" }).execute();
      await expect(ctx.db.updateTable("ledger_audit").set({ ip: "x" }).execute()).rejects.toThrow(
        /append-only/,
      );
      await expect(ctx.db.deleteFrom("ledger_audit").execute()).rejects.toThrow(/append-only/);
      expect(audit(ctx.raw)).toHaveLength(1);
    });
  });

  describe("audit write failure", () => {
    it("reaches the caller, after the change itself was applied", async () => {
      ctx.raw.exec("DROP TABLE ledger_audit");
      const id = uuidv7();
      await expect(ctx.db.insertInto("tags").values({ id, label: "t" }).execute()).rejects.toThrow(
        /ledger_audit/,
      );
      const stored = ctx.raw.prepare("SELECT id FROM tags WHERE id = ?").get(id);
      expect(stored).toBeDefined();
    });
  });

  describe("raw SQL", () => {
    it("throws on a DELETE of a table with deleted_at and deletes nothing", async () => {
      const id = uuidv7();
      await ctx.db
        .insertInto("users")
        .values({ id, name: "n", email: null, deleted_at: null })
        .execute();
      await expect(sql`DELETE FROM users WHERE id = ${id}`.execute(ctx.db)).rejects.toBeInstanceOf(
        LedgerRawDeleteError,
      );
      await expect(sql`delete from "users"`.execute(ctx.db)).rejects.toBeInstanceOf(
        LedgerRawDeleteError,
      );
      await expect(
        sql`WITH x AS (SELECT 1) DELETE FROM main.users`.execute(ctx.db),
      ).rejects.toBeInstanceOf(LedgerRawDeleteError);
      expect(await ctx.db.selectFrom("users").selectAll().execute()).toHaveLength(1);
    });

    it("throws when the table is interpolated with sql.table or sql.id", async () => {
      const id = uuidv7();
      await ctx.db
        .insertInto("users")
        .values({ id, name: "n", email: null, deleted_at: null })
        .execute();
      await expect(sql`delete from ${sql.table("users")}`.execute(ctx.db)).rejects.toBeInstanceOf(
        LedgerRawDeleteError,
      );
      await expect(sql`delete from ${sql.id("users")}`.execute(ctx.db)).rejects.toBeInstanceOf(
        LedgerRawDeleteError,
      );
      await expect(
        sql`delete from ${sql.table("main.users")}`.execute(ctx.db),
      ).rejects.toBeInstanceOf(LedgerRawDeleteError);
      await expect(sql`${sql.raw("delete")} from users`.execute(ctx.db)).rejects.toBeInstanceOf(
        LedgerRawDeleteError,
      );
      expect(await ctx.db.selectFrom("users").selectAll().execute()).toHaveLength(1);
    });

    it("refuses a DELETE whose target is a bound value it cannot name", async () => {
      await expect(sql`delete from ${sql.val("users")}`.execute(ctx.db)).rejects.toBeInstanceOf(
        LedgerRawDeleteError,
      );
    });

    it("runs an interpolated DELETE of a table without deleted_at", async () => {
      await ctx.db.insertInto("tags").values({ id: uuidv7(), label: "t" }).execute();
      await sql`delete from ${sql.table("tags")}`.execute(ctx.db);
      expect(await ctx.db.selectFrom("tags").selectAll().execute()).toHaveLength(0);
    });

    it("runs a DELETE of a table without deleted_at as written", async () => {
      await ctx.db.insertInto("tags").values({ id: uuidv7(), label: "t" }).execute();
      await sql`DELETE FROM tags`.execute(ctx.db);
      expect(await ctx.db.selectFrom("tags").selectAll().execute()).toHaveLength(0);
    });

    it("runs a SELECT untouched", async () => {
      const result = await sql<{ n: number }>`SELECT 1 AS n`.execute(ctx.db);
      expect(result.rows).toEqual([{ n: 1 }]);
    });
  });
});

describe("ledger context across bundled entry points", () => {
  it("is shared between two copies of the context module", async () => {
    const a = await import("../../src/core/context.js?copy=a");
    const b = await import("../../src/core/context.js?copy=b");
    expect(a).not.toBe(b);
    const seen = a.runWithLedgerContext(a.createLedgerContext({ userId: "shared" }), () =>
      b.getLedgerContext(),
    );
    expect(seen?.userId).toBe("shared");
  });
});
