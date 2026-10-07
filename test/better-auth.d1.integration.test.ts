/**
 * better-auth on Cloudflare D1: atomic audit through ledgerD1.
 *
 * The database is a D1-shaped fake over node:sqlite: prepare/bind/all/run/
 * first/raw, exec, and a batch() that is atomic and nothing else. There is no
 * transaction API, so better-auth picks its real D1 dialect with
 * transaction: false, exactly as it does on Workers. The suite then runs the
 * same flows as the transaction-backed suite and also proves, from the fake's
 * call log, that no write to an audited table ran outside a batch.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { organization } from "better-auth/plugins";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ledgerD1, ledgerPlugin } from "../src/better-auth.js";
import type { D1Like, D1ResultLike, D1StatementLike } from "../src/better-auth.js";
import { createLedgerContext, runWithLedgerContext } from "../src/core/context.js";

const TEST_SECRET = "ledger-integration-secret-that-is-long-enough-for-validation";
const BASE_URL = "http://localhost:3000";

/** What the fake saw: every statement run on its own, and every batch. */
interface D1Log {
  single: string[];
  batches: string[][];
}

type FakeD1 = D1Like & { log: D1Log; beforeBatch: (() => void) | null };

/** A D1 binding over node:sqlite. batch() is atomic; there is no other transaction. */
function fakeD1(sqlite: DatabaseSync): FakeD1 {
  const log: D1Log = { single: [], batches: [] };

  function execute(sql: string, params: unknown[]): D1ResultLike {
    const rows = sqlite.prepare(sql).all(...(params as SQLInputValue[]));
    const meta = sqlite.prepare("SELECT changes() AS changes, last_insert_rowid() AS id").get() as {
      changes: number;
      id: number;
    };
    return {
      results: rows,
      success: true,
      meta: { changes: meta.changes, last_row_id: meta.id },
    };
  }

  interface Fake extends D1StatementLike {
    sql: string;
    params: unknown[];
  }

  function statement(sql: string, params: unknown[]): Fake {
    return {
      sql,
      params,
      bind: (...values) => statement(sql, values),
      all: async () => {
        log.single.push(sql);
        return execute(sql, params);
      },
      run: async () => {
        log.single.push(sql);
        return execute(sql, params);
      },
      first: async () => {
        log.single.push(sql);
        return execute(sql, params).results?.[0] ?? null;
      },
      raw: async () => {
        log.single.push(sql);
        return (execute(sql, params).results ?? []).map((row) => Object.values(row as object));
      },
    };
  }

  const fake: FakeD1 = {
    log,
    beforeBatch: null,
    prepare: (sql) => statement(sql, []),
    exec: async (query) => {
      sqlite.exec(query);
      return {};
    },
    batch: async (statements) => {
      fake.beforeBatch?.();
      const fakes = statements as Fake[];
      log.batches.push(fakes.map((s) => s.sql));
      sqlite.exec("BEGIN");
      try {
        const results = fakes.map((s) => execute(s.sql, s.params));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return fake;
}

describe("better-auth on D1: atomic audit of any named table, one batch per write", () => {
  const sqlite = new DatabaseSync(":memory:");
  const d1 = fakeD1(sqlite);

  /** Read a JSON-object request body; the test endpoints below take no schema. */
  function bodyOf(body: unknown): Record<string, unknown> {
    return typeof body === "object" && body !== null
      ? Object.fromEntries(Object.entries(body))
      : {};
  }

  // A plugin table whose secret column is named `key`: no default pattern
  // other than "key" itself is a substring of it.
  const vaultPlugin = {
    id: "vault",
    schema: {
      vaultItem: {
        fields: {
          userId: { type: "string", required: true },
          label: { type: "string", required: true },
          key: { type: "string", required: false },
        },
      },
    },
    endpoints: {
      createVaultItem: createAuthEndpoint("/vault/create", { method: "POST" }, async (ctx) => {
        const body = bodyOf(ctx.body);
        const created = await ctx.context.adapter.create({
          model: "vaultItem",
          data: { userId: body["userId"], label: body["label"], key: body["key"] },
        });
        return ctx.json(created);
      }),
      updateVaultItem: createAuthEndpoint("/vault/update", { method: "POST" }, async (ctx) => {
        const body = bodyOf(ctx.body);
        const updated = await ctx.context.adapter.update({
          model: "vaultItem",
          where: [{ field: "id", value: body["id"] }],
          update: { label: body["label"], key: body["key"] },
        });
        return ctx.json(updated);
      }),
      deleteVaultItem: createAuthEndpoint("/vault/delete", { method: "POST" }, async (ctx) => {
        const body = bodyOf(ctx.body);
        await ctx.context.adapter.delete({
          model: "vaultItem",
          where: [{ field: "id", value: body["id"] }],
        });
        return ctx.json({ ok: true });
      }),
    },
  } satisfies BetterAuthPlugin;

  const options = {
    baseURL: BASE_URL,
    secret: TEST_SECRET,
    database: ledgerD1(d1),
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    logger: { disabled: true },
    user: { deleteUser: { enabled: true } },
    plugins: [
      organization(),
      vaultPlugin,
      ledgerPlugin({
        auditTables: ["user", "account", "session", "organization", "member", "vaultItem"],
      }),
    ],
  } satisfies BetterAuthOptions;
  const auth = betterAuth(options);

  interface AuditRow {
    tableName: string;
    recordId: string;
    action: string;
    oldData: string | null;
    newData: string | null;
    userId: string | null;
    subjectUserId: string | null;
  }

  function entries(filter: { tableName: string; action?: string; recordId?: string }): AuditRow[] {
    const rows = sqlite
      .prepare(
        "SELECT tableName, recordId, action, oldData, newData, userId, subjectUserId FROM ledger_audit_log ORDER BY id",
      )
      .all() as unknown as AuditRow[];
    return rows.filter(
      (row) =>
        row.tableName === filter.tableName &&
        (filter.action === undefined || row.action === filter.action) &&
        (filter.recordId === undefined || row.recordId === filter.recordId),
    );
  }

  function rowCount(table: string): number {
    const row = sqlite.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number };
    return row.n;
  }

  async function handle(request: Request): Promise<Response> {
    const current = await auth.api.getSession({ headers: request.headers });
    return runWithLedgerContext(createLedgerContext({ userId: current?.user.id ?? null }), () =>
      auth.handler(request),
    );
  }

  function post(path: string, body: Record<string, unknown>, headers?: Headers) {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("content-type", "application/json");
    requestHeaders.set("origin", BASE_URL);
    return handle(
      new Request(`${BASE_URL}/api/auth${path}`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
      }),
    );
  }

  function cookieHeaders(response: Response): Headers {
    const cookies = response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .filter((c): c is string => c !== undefined && c.length > 0);
    return new Headers({ cookie: cookies.join("; ") });
  }

  const owner = { email: "owner@example.com", password: "owner-password-123", name: "Owner" };
  let ownerId = "";
  let ownerHeaders = new Headers();
  let orgId = "";
  let itemId = "";

  beforeAll(async () => {
    const { runMigrations } = await getMigrations({ ...auth.options, database: sqlite });
    await runMigrations();
  });

  afterAll(() => {
    sqlite.close();
  });

  test("user: sign-up, update, and the actor", async () => {
    const response = await post("/sign-up/email", owner);
    expect(response.status).toBe(200);
    ownerId = ((await response.json()) as { user: { id: string } }).user.id;
    ownerHeaders = cookieHeaders(response);

    expect(entries({ tableName: "user", action: "INSERT", recordId: ownerId })).toMatchObject([
      { userId: ownerId, subjectUserId: ownerId },
    ]);
    // The new session and the credential account were audited as well.
    expect(entries({ tableName: "session", action: "INSERT" })).toHaveLength(1);
    const accountInsert = entries({ tableName: "account", action: "INSERT" });
    expect(accountInsert).toHaveLength(1);
    expect(JSON.parse(accountInsert[0]?.newData ?? "{}")).toMatchObject({ password: "[REDACTED]" });
    expect(accountInsert[0]?.subjectUserId).toBe(ownerId);

    const update = await post("/update-user", { name: "Owner Renamed" }, ownerHeaders);
    expect(update.status).toBe(200);
    const updates = entries({ tableName: "user", action: "UPDATE", recordId: ownerId });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.userId).toBe(ownerId);
    // A true before-image, not just the change set.
    expect(JSON.parse(updates[0]?.oldData ?? "{}")).toMatchObject({ name: "Owner" });
    expect(JSON.parse(updates[0]?.newData ?? "{}")).toMatchObject({ name: "Owner Renamed" });
  });

  test("organization and member: plugin tables written straight through the adapter", async () => {
    const response = await post(
      "/organization/create",
      { name: "Acme", slug: "acme" },
      ownerHeaders,
    );
    expect(response.status).toBe(200);
    orgId = ((await response.json()) as { id: string }).id;

    const orgInsert = entries({ tableName: "organization", action: "INSERT", recordId: orgId });
    expect(orgInsert).toMatchObject([{ userId: ownerId, subjectUserId: null }]);
    expect(JSON.parse(orgInsert[0]?.newData ?? "{}")).toMatchObject({ name: "Acme" });
    const memberInsert = entries({ tableName: "member", action: "INSERT" });
    expect(memberInsert).toHaveLength(1);
    expect(memberInsert[0]).toMatchObject({ userId: ownerId, subjectUserId: ownerId });

    const update = await post(
      "/organization/update",
      { organizationId: orgId, data: { name: "Acme Inc" } },
      ownerHeaders,
    );
    expect(update.status).toBe(200);
    const orgUpdate = entries({ tableName: "organization", action: "UPDATE", recordId: orgId });
    expect(orgUpdate).toHaveLength(1);
    expect(orgUpdate[0]?.userId).toBe(ownerId);
    expect(JSON.parse(orgUpdate[0]?.oldData ?? "{}")).toMatchObject({ name: "Acme" });
    expect(JSON.parse(orgUpdate[0]?.newData ?? "{}")).toMatchObject({ name: "Acme Inc" });

    const removal = await post("/organization/delete", { organizationId: orgId }, ownerHeaders);
    expect(removal.status).toBe(200);
    const orgDelete = entries({ tableName: "organization", action: "DELETE", recordId: orgId });
    expect(orgDelete).toMatchObject([{ userId: ownerId }]);
    expect(JSON.parse(orgDelete[0]?.oldData ?? "{}")).toMatchObject({ name: "Acme Inc" });
    expect(orgDelete[0]?.newData).toBeNull();
    expect(entries({ tableName: "member", action: "DELETE" })).toHaveLength(1);
  });

  test("a plugin table with a `key` column is redacted, and the row itself is not", async () => {
    const created = await post(
      "/vault/create",
      { userId: ownerId, label: "deploy", key: "sk-live-super-secret" },
      ownerHeaders,
    );
    expect(created.status).toBe(200);
    itemId = ((await created.json()) as { id: string }).id;

    const insert = entries({ tableName: "vaultItem", action: "INSERT", recordId: itemId });
    expect(insert).toMatchObject([{ userId: ownerId, subjectUserId: ownerId }]);
    expect(JSON.parse(insert[0]?.newData ?? "{}")).toMatchObject({
      label: "deploy",
      key: "[REDACTED]",
    });
    expect(insert[0]?.newData).not.toContain("sk-live-super-secret");
    const stored = sqlite.prepare('SELECT "key" FROM "vaultItem" WHERE id = ?').get(itemId) as {
      key: string;
    };
    expect(stored.key).toBe("sk-live-super-secret");

    const updated = await post(
      "/vault/update",
      { id: itemId, label: "deploy-2", key: "sk-live-rotated" },
      ownerHeaders,
    );
    expect(updated.status).toBe(200);
    const update = entries({ tableName: "vaultItem", action: "UPDATE", recordId: itemId });
    expect(update).toHaveLength(1);
    expect(update[0]?.oldData).not.toContain("sk-live");
    expect(update[0]?.newData).not.toContain("sk-live");
    expect(JSON.parse(update[0]?.oldData ?? "{}")).toMatchObject({ label: "deploy" });
  });

  test("a forced audit-write failure leaves no change, and the caller gets the error", async () => {
    sqlite.exec(
      "CREATE TRIGGER force_audit_failure BEFORE INSERT ON ledger_audit_log BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END",
    );
    try {
      const itemsBefore = rowCount("vaultItem");
      const created = await post(
        "/vault/create",
        { userId: ownerId, label: "never-written", key: "x" },
        ownerHeaders,
      );
      expect(created.status).toBeGreaterThanOrEqual(500);
      expect(rowCount("vaultItem")).toBe(itemsBefore);

      const update = await post("/update-user", { name: "Never Applied" }, ownerHeaders);
      expect(update.status).toBeGreaterThanOrEqual(500);
      const row = sqlite.prepare("SELECT name FROM user WHERE id = ?").get(ownerId) as {
        name: string;
      };
      expect(row.name).toBe("Owner Renamed");
    } finally {
      sqlite.exec("DROP TRIGGER force_audit_failure");
    }
  });

  test("a forced change failure leaves no audit row", async () => {
    sqlite.exec(
      "CREATE TRIGGER force_change_failure BEFORE DELETE ON vaultItem BEGIN SELECT RAISE(ABORT, 'forced change failure'); END",
    );
    try {
      const auditBefore = rowCount("ledger_audit_log");
      const removal = await post("/vault/delete", { id: itemId }, ownerHeaders);
      expect(removal.status).toBeGreaterThanOrEqual(500);
      expect(rowCount("vaultItem")).toBe(1);
      expect(rowCount("ledger_audit_log")).toBe(auditBefore);
    } finally {
      sqlite.exec("DROP TRIGGER force_change_failure");
    }
  });

  test("a plugin-table delete writes a DELETE entry naming the actor", async () => {
    const removal = await post("/vault/delete", { id: itemId }, ownerHeaders);
    expect(removal.status).toBe(200);
    const deletes = entries({ tableName: "vaultItem", action: "DELETE", recordId: itemId });
    expect(deletes).toMatchObject([{ userId: ownerId, subjectUserId: ownerId, newData: null }]);
    expect(deletes[0]?.oldData).not.toContain("sk-live");
  });

  test("a user hard delete writes DELETE entries for the user, account, and session", async () => {
    const response = await post("/delete-user", { password: owner.password }, ownerHeaders);
    expect(response.status).toBe(200);
    expect(entries({ tableName: "user", action: "DELETE", recordId: ownerId })).toMatchObject([
      { userId: ownerId, subjectUserId: ownerId, newData: null },
    ]);
    expect(entries({ tableName: "account", action: "DELETE" })).toHaveLength(1);
    expect(entries({ tableName: "session", action: "DELETE" })).toHaveLength(1);
    expect(rowCount("user")).toBe(0);
  });
});

describe("better-auth on D1: the write path", () => {
  const sqlite = new DatabaseSync(":memory:");
  const d1 = fakeD1(sqlite);
  const auth = betterAuth({
    baseURL: BASE_URL,
    secret: TEST_SECRET,
    database: ledgerD1(d1),
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    logger: { disabled: true },
    plugins: [ledgerPlugin({ auditTables: ["user", "account", "session"] })],
  });

  beforeAll(async () => {
    const { runMigrations } = await getMigrations({ ...auth.options, database: sqlite });
    await runMigrations();
  });

  afterAll(() => {
    sqlite.close();
  });

  test("no write to an audited table runs outside a batch, and every batch carries its audit row", async () => {
    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ email: "d1@example.com", password: "d1-password-123", name: "D1" }),
      }),
    );
    expect(response.status).toBe(200);
    const writes = /^\s*(insert|update|delete)/i;
    expect(d1.log.single.filter((sql) => writes.test(sql))).toEqual([]);
    const audited = d1.log.batches.filter((batch) =>
      batch.some((sql) => /"?(user|account|session)"?\s*\(/i.test(sql) && writes.test(sql)),
    );
    expect(audited.length).toBeGreaterThanOrEqual(3);
    for (const batch of audited) {
      expect(batch.some((sql) => sql.includes("ledger_audit_log"))).toBe(true);
    }
  });

  test("a row that matches between the read and the write aborts the batch, change and audit both", async () => {
    const context = await auth.$context;
    const [existing] = sqlite.prepare("SELECT id FROM user").all() as { id: string }[];
    const userId = existing?.id ?? "";
    const insertSession = (id: string) =>
      sqlite
        .prepare(
          "INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          "2099-01-01T00:00:00.000Z",
          `token-${id}`,
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
          userId,
        );
    insertSession("s-one");
    const count = (sql: string): number => (sqlite.prepare(sql).get() as { n: number }).n;
    const auditBefore = count("SELECT count(*) AS n FROM ledger_audit_log");
    // A second session for the same user appears after the adapter read the
    // matching rows and before the batch ran.
    d1.beforeBatch = () => {
      d1.beforeBatch = null;
      insertSession("s-two");
    };
    await expect(
      context.adapter.updateMany({
        model: "session",
        where: [{ field: "userId", value: userId }],
        update: { userAgent: "changed" },
      }),
    ).rejects.toThrow(/changed between the read and the write/);
    expect(count("SELECT count(*) AS n FROM session WHERE userAgent = 'changed'")).toBe(0);
    expect(count("SELECT count(*) AS n FROM ledger_audit_log")).toBe(auditBefore);
  });
});

describe("better-auth on D1: init", () => {
  test("an unwrapped D1 binding fails at init and says to wrap it", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const auth = betterAuth({
      baseURL: BASE_URL,
      secret: TEST_SECRET,
      database: fakeD1(sqlite),
      logger: { disabled: true },
      plugins: [ledgerPlugin({ auditTables: ["user"] })],
    });
    await expect(auth.$context).rejects.toThrow(/ledgerD1/);
    sqlite.close();
  });
});
