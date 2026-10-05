/**
 * better-auth integration suite.
 *
 * Boots a real betterAuth() instance with ledgerPlugin (softDeleteUser on) and
 * the sign-in gate recipe from docs/better-auth.mdx, over drizzleAdapter on an
 * in-memory node:sqlite database. Every flow goes through auth.handler as an HTTP
 * Request, wrapped in the ledger-context middleware the docs require, so a changed
 * hook signature, merge rule, or route behavior in better-auth fails here.
 *
 * Runs against the better-auth in devDependencies; CI also runs it against the
 * floor and the latest of the declared peer range.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { getAuthTables } from "better-auth/db";
import { getMigrations } from "better-auth/db/migration";
import { admin, testUtils } from "better-auth/plugins";
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
