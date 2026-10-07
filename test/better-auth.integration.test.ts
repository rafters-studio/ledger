/**
 * better-auth integration suite.
 *
 * Boots a real betterAuth() instance with ledgerPlugin (softDeleteUser on) and
 * the sign-in gate recipe from docs/better-auth.mdx, over drizzleAdapter on an
 * in-memory node:sqlite database. Every flow goes through auth.handler as an HTTP
 * Request, wrapped in the ledger-context middleware from the docs, so a changed
 * hook signature, merge rule, or route behavior in better-auth fails here. The
 * no-context suite covers attribution without that middleware.
 *
 * Runs against the better-auth in devDependencies; CI also runs it against the
 * floor and the latest of the declared peer range.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { getAuthTables } from "better-auth/db";
import { getMigrations } from "better-auth/db/migration";
import { admin, organization, testUtils } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ledgerPlugin } from "../src/better-auth.js";
import type { LedgerAuditEntry } from "../src/better-auth.js";
import { createLedgerContext, runWithLedgerContext } from "../src/core/context.js";
import { isUserDataPurged, purgeUserData } from "../src/drizzle/gdpr.js";
import { AUDIT_LOG_INDEXES, auditLog } from "../src/drizzle/schema/sqlite.js";

// better-auth's tables as the app declares them for drizzleAdapter, including
// the admin() plugin's fields and the deletedAt/deletedBy soft-delete columns.
// Column names are better-auth's field names, which is what getMigrations creates.
const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull(),
  image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  role: text("role"),
  banned: integer("banned", { mode: "boolean" }),
  banReason: text("banReason"),
  banExpires: integer("banExpires", { mode: "timestamp_ms" }),
  deletedAt: integer("deletedAt", { mode: "timestamp_ms" }),
  deletedBy: text("deletedBy"),
});

const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId").notNull(),
  impersonatedBy: text("impersonatedBy"),
});

// better-auth 1.7.0 through 1.7.2 add a required account.issuer column
// (unique with accountId); 1.7.3 removed it. The suite runs on both ends of
// the peer range, so the schema follows the installed version's own tables.
const accountHasIssuer = "issuer" in getAuthTables({}).account.fields;

/** The issuer field for a test-created account, on versions that have one. */
function issuerFor(issuer: string): { issuer?: string } {
  return accountHasIssuer ? { issuer } : {};
}

const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  ...(accountHasIssuer ? { issuer: text("issuer").notNull() } : {}),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId").notNull(),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp_ms" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }),
});

const AUDIT_LOG_DDL = `CREATE TABLE audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  action TEXT NOT NULL,
  old_data TEXT,
  new_data TEXT,
  user_id TEXT,
  ip TEXT,
  user_agent TEXT,
  endpoint TEXT,
  request_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
)`;

type ProxyMethod = "run" | "all" | "values" | "get";

/** Run one drizzle sqlite-proxy query against node:sqlite. Rows go back as value arrays. */
function runProxyQuery(
  sqlite: DatabaseSync,
  sql: string,
  params: unknown[],
  method: ProxyMethod,
): { rows: unknown[] } {
  const statement = sqlite.prepare(sql);
  const args = params as SQLInputValue[];
  if (method === "run") {
    statement.run(...args);
    return { rows: [] };
  }
  if (method === "get") {
    const row = statement.get(...args);
    return { rows: row ? Object.values(row) : [] };
  }
  return { rows: statement.all(...args).map((row) => Object.values(row)) };
}

const TEST_SECRET = "ledger-integration-secret-that-is-long-enough-for-validation";
const BASE_URL = "http://localhost:3000";

describe("better-auth integration: ledgerPlugin inside a real betterAuth() instance", () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = drizzle(
    async (sql, params, method) => runProxyQuery(sqlite, sql, params, method),
    // Batches run atomically, the path D1 and libsql users get from purgeUserData.
    async (queries) => {
      sqlite.exec("BEGIN");
      try {
        const results = queries.map((q) => runProxyQuery(sqlite, q.sql, q.params, q.method));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  );

  async function writeAuditEntry(entry: LedgerAuditEntry): Promise<void> {
    await db.insert(auditLog).values({
      id: uuidv7(),
      tableName: entry.tableName,
      recordId: entry.recordId,
      action: entry.action,
      oldData: entry.oldData ? JSON.stringify(entry.oldData) : null,
      newData: entry.newData ? JSON.stringify(entry.newData) : null,
      userId: entry.userId,
      ip: null,
      userAgent: null,
      endpoint: null,
      requestId: null,
      createdAt: new Date(),
    });
  }

  const authOptions = {
    baseURL: BASE_URL,
    secret: TEST_SECRET,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: { user, session, account, verification },
    }),
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    logger: { disabled: true },
    account: { accountLinking: { enabled: true } },
    user: {
      additionalFields: {
        deletedAt: { type: "date", required: false, input: false },
        deletedBy: { type: "string", required: false, input: false },
      },
      deleteUser: { enabled: true },
    },
    // The sign-in gate recipe from the docs.
    databaseHooks: {
      session: {
        create: {
          before: async (newSession) => {
            const [u] = await db.select().from(user).where(eq(user.id, newSession.userId));
            if (u?.deletedAt) {
              throw new APIError("FORBIDDEN", { message: "Account deleted" });
            }
          },
        },
      },
    },
    plugins: [
      ledgerPlugin({ auditTables: ["user", "account"], softDeleteUser: true, writeAuditEntry }),
      admin(),
      testUtils(),
    ],
  } satisfies BetterAuthOptions;
  const auth = betterAuth(authOptions);

  // The same database and schema with softDeleteUser off: a user delete is
  // a real row delete, audited by the plugin's delete.after hooks.
  const hardDeleteAuth = betterAuth({
    ...authOptions,
    plugins: [ledgerPlugin({ auditTables: ["user", "account"], writeAuditEntry }), testUtils()],
  });
  type AuthInstance = typeof auth | typeof hardDeleteAuth;

  /**
   * The ledger-context middleware from the docs, in front of auth.handler:
   * resolve the authenticated principal, then run the request inside it.
   */
  async function handle(request: Request, instance: AuthInstance = auth): Promise<Response> {
    const current = await instance.api.getSession({ headers: request.headers });
    const url = new URL(request.url);
    return runWithLedgerContext(
      createLedgerContext({
        userId: current?.user.id ?? null,
        endpoint: `${request.method} ${url.pathname}`,
      }),
      () => instance.handler(request),
    );
  }

  function post(
    path: string,
    body: Record<string, unknown>,
    headers?: Headers,
    instance?: AuthInstance,
  ): Promise<Response> {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("content-type", "application/json");
    requestHeaders.set("origin", BASE_URL);
    return handle(
      new Request(`${BASE_URL}/api/auth${path}`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
      }),
      instance,
    );
  }

  /** Turn a response's Set-Cookie into a Cookie request header. */
  function cookieHeaders(response: Response): Headers {
    const cookies = response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .filter((c): c is string => c !== undefined && c.length > 0);
    return new Headers({ cookie: cookies.join("; ") });
  }

  function auditRows() {
    return db.select().from(auditLog);
  }

  const member = { email: "member@example.com", password: "member-password-123", name: "Member" };
  let memberId = "";
  let memberHeaders = new Headers();
  let adminId = "";
  let deleteResponse: Response | undefined;

  beforeAll(async () => {
    // better-auth's own migrations create its tables (with the plugin and
    // additional fields) on the same database the Drizzle adapter uses.
    const { runMigrations } = await getMigrations({ ...auth.options, database: sqlite });
    await runMigrations();
    sqlite.exec(AUDIT_LOG_DDL);
    for (const index of AUDIT_LOG_INDEXES) {
      sqlite.exec(index);
    }
  });

  afterAll(() => {
    sqlite.close();
  });

  test("email sign-up writes a self-attributed INSERT entry", async () => {
    const response = await post("/sign-up/email", member);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ user: { email: member.email } });
    memberId = (body as { user: { id: string } }).user.id;
    memberHeaders = cookieHeaders(response);

    const entries = (await auditRows()).filter(
      (e) => e.tableName === "user" && e.recordId === memberId,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "INSERT", userId: memberId });
    expect(JSON.parse(entries[0]?.newData ?? "{}")).toMatchObject({ email: member.email });
  });

  test("an admin updating another user writes an UPDATE attributed to the admin", async () => {
    const ctx = await auth.$context;
    const adminUser = await ctx.test.saveUser(
      ctx.test.createUser({ email: "admin@example.com", name: "Admin", role: "admin" }),
    );
    adminId = adminUser.id;
    const { headers } = await ctx.test.login({ userId: adminId });

    const response = await post(
      "/admin/update-user",
      { userId: memberId, data: { name: "Renamed By Admin" } },
      headers,
    );
    expect(response.status).toBe(200);

    const updates = (await auditRows()).filter(
      (e) => e.tableName === "user" && e.recordId === memberId && e.action === "UPDATE",
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.userId).toBe(adminId);
    expect(JSON.parse(updates[0]?.newData ?? "{}")).toMatchObject({ name: "Renamed By Admin" });
  });

  describe("account unlink", () => {
    let linkedAccountId = "";

    test("unlinking a second provider removes its account row", async () => {
      const ctx = await auth.$context;
      const linked = await ctx.internalAdapter.createAccount({
        userId: memberId,
        providerId: "github",
        accountId: "github-member",
        accessToken: "gho_member_access_token",
        refreshToken: "ghr_member_refresh_token",
        ...issuerFor("local:oauth:github"),
      });
      linkedAccountId = linked.id;

      // 1.7 unlinks by better-auth account id, not by provider id.
      const response = await post("/unlink-account", { accountId: linkedAccountId }, memberHeaders);
      expect(response.status).toBe(200);
      const rows = await db.select().from(account).where(eq(account.id, linkedAccountId));
      expect(rows).toHaveLength(0);
    });

    test("unlinking records one redacted DELETE entry for the account (#45)", async () => {
      const deletes = (await auditRows()).filter(
        (e) => e.tableName === "account" && e.recordId === linkedAccountId && e.action === "DELETE",
      );
      expect(deletes).toHaveLength(1);
      // The ledger context survives better-auth's after-transaction queue.
      expect(deletes[0]?.userId).toBe(memberId);
      expect(deletes[0]?.newData).toBeNull();
      const oldData: unknown = JSON.parse(deletes[0]?.oldData ?? "null");
      expect(oldData).toMatchObject({ id: linkedAccountId, providerId: "github" });
      expect(oldData).toMatchObject({ accessToken: "[REDACTED]", refreshToken: "[REDACTED]" });
      expect(deletes[0]?.oldData).not.toContain("gho_member_access_token");
      expect(deletes[0]?.oldData).not.toContain("ghr_member_refresh_token");
    });
  });

  describe("self-service delete over auth.handler", () => {
    test("soft-deletes the user, revokes every session, and audits SOFT_DELETE once", async () => {
      const before = await db.select().from(session).where(eq(session.userId, memberId));
      expect(before.length).toBeGreaterThan(0);

      deleteResponse = await post("/delete-user", {}, memberHeaders);

      const [row] = await db.select().from(user).where(eq(user.id, memberId));
      expect(row).toBeDefined();
      expect(row?.deletedAt).toBeInstanceOf(Date);
      expect(row?.deletedBy).toBe(memberId);
      const after = await db.select().from(session).where(eq(session.userId, memberId));
      expect(after).toHaveLength(0);

      const softDeletes = (await auditRows()).filter(
        (e) => e.recordId === memberId && e.action === "SOFT_DELETE",
      );
      expect(softDeletes).toHaveLength(1);
      expect(softDeletes[0]?.userId).toBe(memberId);
    });

    test("answers the browser with 200 and clears the session cookie (#44)", async () => {
      expect(deleteResponse?.status).toBe(200);
      expect(await deleteResponse?.json()).toMatchObject({ success: true });
      const cleared = deleteResponse?.headers
        .getSetCookie()
        .find((c) => c.startsWith("better-auth.session_token="));
      expect(cleared).toMatch(/Max-Age=0/);
    });

    test("better-auth hard-deletes the account rows before the user hook runs", async () => {
      const rows = await db.select().from(account).where(eq(account.userId, memberId));
      expect(rows).toHaveLength(0);
    });
  });

  describe("hard delete with softDeleteUser off", () => {
    const leaver = {
      email: "leaver@example.com",
      password: "leaver-password-123",
      name: "Leaver",
    };
    let leaverId = "";

    test("deletes the user row and records one redacted DELETE entry (#45)", async () => {
      const signUp = await post("/sign-up/email", leaver, undefined, hardDeleteAuth);
      expect(signUp.status).toBe(200);
      leaverId = ((await signUp.json()) as { user: { id: string } }).user.id;

      const response = await post("/delete-user", {}, cookieHeaders(signUp), hardDeleteAuth);
      expect(response.status).toBe(200);
      expect(await db.select().from(user).where(eq(user.id, leaverId))).toHaveLength(0);

      const userDeletes = (await auditRows()).filter(
        (e) => e.tableName === "user" && e.recordId === leaverId && e.action === "DELETE",
      );
      expect(userDeletes).toHaveLength(1);
      expect(userDeletes[0]?.userId).toBe(leaverId);
      expect(JSON.parse(userDeletes[0]?.oldData ?? "null")).toMatchObject({
        id: leaverId,
        email: leaver.email,
      });
      expect(
        (await auditRows()).filter((e) => e.recordId === leaverId && e.action === "SOFT_DELETE"),
      ).toHaveLength(0);
    });

    test("the credential account deleted ahead of the user is audited without its hash", async () => {
      const accountDeletes = (await auditRows()).filter(
        (e) => e.tableName === "account" && e.action === "DELETE" && e.userId === leaverId,
      );
      expect(accountDeletes).toHaveLength(1);
      const oldData: unknown = JSON.parse(accountDeletes[0]?.oldData ?? "null");
      expect(oldData).toMatchObject({ providerId: "credential", userId: leaverId });
      expect(oldData).toMatchObject({ password: "[REDACTED]" });
    });
  });

  test("sign-in on the soft-deleted user is rejected by the gate", async () => {
    // The row survives with its email, so a later sign-in can reach it again
    // (an OAuth sign-in with account linking attaches a new account to it).
    // Restore a credential account to drive that path through the gate.
    const ctx = await auth.$context;
    await ctx.internalAdapter.createAccount({
      userId: memberId,
      providerId: "credential",
      accountId: memberId,
      password: await ctx.password.hash(member.password),
      ...issuerFor("local:credential"),
    });

    const response = await post("/sign-in/email", {
      email: member.email,
      password: member.password,
    });
    expect(response.status).toBe(403);
    const sessions = await db.select().from(session).where(eq(session.userId, memberId));
    expect(sessions).toHaveLength(0);
  });

  test("purgeUserData anonymizes every row the flows produced", async () => {
    // The purge matches entries about the member's record and entries the
    // member performed (the account DELETEs from unlink and self-delete).
    const matchedIds = new Set(
      (await auditRows())
        .filter((e) => e.recordId === memberId || e.userId === memberId)
        .map((e) => e.id),
    );
    const result = await purgeUserData(db, auditLog, memberId);
    expect(result.entriesSkipped).toBe(0);
    expect(result.entriesAnonymized).toBe(matchedIds.size);

    const rows = await auditRows();
    const purged = rows.filter((e) => matchedIds.has(e.id));
    expect(purged.filter((e) => e.recordId === memberId).length).toBeGreaterThanOrEqual(3);
    expect(purged.filter((e) => e.tableName === "account" && e.action === "DELETE")).toHaveLength(
      2,
    );
    for (const entry of purged) {
      expect(entry.oldData ?? "").not.toContain(member.email);
      expect(entry.newData ?? "").not.toContain(member.email);
    }
    // Self-performed entries lose the identifier; the admin's keeps the admin.
    for (const entry of purged.filter((e) => e.action !== "UPDATE")) {
      expect(entry.userId).toBe("PURGED_USER");
    }
    expect(purged.find((e) => e.action === "UPDATE")?.userId).toBe(adminId);

    expect(rows.filter((e) => e.action === "PURGE")).toHaveLength(1);
    expect(await isUserDataPurged(db, auditLog, memberId)).toBe(true);
  });
});

/**
 * Atomic audit: auditTables without writeAuditEntry. The audit row is written
 * through the better-auth adapter in the change's own transaction, for core
 * tables, for tables the organization plugin writes straight through
 * ctx.context.adapter, and for a plugin table with a `key` column.
 */
describe("better-auth integration: atomic audit of any named table", () => {
  const sqlite = new DatabaseSync(":memory:");

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
    database: sqlite,
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

describe("better-auth integration: atomic audit refuses what it cannot do atomically", () => {
  test("an auditTables name that is not a model in the schema fails at init", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const auth = betterAuth({
      baseURL: BASE_URL,
      secret: TEST_SECRET,
      database: sqlite,
      logger: { disabled: true },
      plugins: [ledgerPlugin({ auditTables: ["user", "passkey"] })],
    });
    await expect(auth.$context).rejects.toThrow(/"passkey".*not a model/);
    sqlite.close();
  });

  test("an adapter without real transactions fails at init instead of auditing non-atomically", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const db = drizzle(async (sql, params, method) => runProxyQuery(sqlite, sql, params, method));
    const auth = betterAuth({
      baseURL: BASE_URL,
      secret: TEST_SECRET,
      database: drizzleAdapter(db, {
        provider: "sqlite",
        schema: { user, session, account, verification },
      }),
      logger: { disabled: true },
      plugins: [ledgerPlugin({ auditTables: ["user"] })],
    });
    await expect(auth.$context).rejects.toThrow(/real transactions/);
    sqlite.close();
  });
});

describe("better-auth integration: atomic audit with softDeleteUser", () => {
  const sqlite = new DatabaseSync(":memory:");
  const auth = betterAuth({
    baseURL: BASE_URL,
    secret: TEST_SECRET,
    database: sqlite,
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    logger: { disabled: true },
    user: {
      additionalFields: {
        deletedAt: { type: "date", required: false, input: false },
        deletedBy: { type: "string", required: false, input: false },
      },
      deleteUser: { enabled: true },
    },
    plugins: [ledgerPlugin({ auditTables: ["user"], softDeleteUser: true })],
  });

  beforeAll(async () => {
    const { runMigrations } = await getMigrations({ ...auth.options, database: sqlite });
    await runMigrations();
  });

  afterAll(() => {
    sqlite.close();
  });

  test("a soft delete writes one SOFT_DELETE entry with the row, and no UPDATE", async () => {
    const headers = new Headers({ "content-type": "application/json", origin: BASE_URL });
    const signUp = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          email: "gone@example.com",
          password: "gone-password-123",
          name: "Gone",
        }),
      }),
    );
    expect(signUp.status).toBe(200);
    const userId = ((await signUp.json()) as { user: { id: string } }).user.id;
    const cookie = signUp.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    const removal = await auth.handler(
      new Request(`${BASE_URL}/api/auth/delete-user`, {
        method: "POST",
        headers: new Headers({ ...Object.fromEntries(headers), cookie }),
        body: JSON.stringify({ password: "gone-password-123" }),
      }),
    );
    expect(removal.status).toBe(200);

    const rows = sqlite
      .prepare("SELECT action, userId, oldData, newData FROM ledger_audit_log WHERE recordId = ?")
      .all(userId) as unknown as {
      action: string;
      userId: string | null;
      oldData: string | null;
      newData: string | null;
    }[];
    expect(rows.map((r) => r.action).sort()).toEqual(["INSERT", "SOFT_DELETE"]);
    const soft = rows.find((r) => r.action === "SOFT_DELETE");
    expect(soft?.userId).toBe(userId);
    expect(JSON.parse(soft?.oldData ?? "{}")).toMatchObject({ email: "gone@example.com" });
    expect(JSON.parse(soft?.newData ?? "{}")).toMatchObject({ email: "gone@example.com" });
    expect(JSON.parse(soft?.newData ?? "{}")["deletedAt"]).toBeTruthy();

    const row = sqlite
      .prepare("SELECT deletedAt, deletedBy FROM user WHERE id = ?")
      .get(userId) as {
      deletedAt: number | null;
      deletedBy: string | null;
    };
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedBy).toBe(userId);
  });
});
