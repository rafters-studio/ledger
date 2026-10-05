/**
 * better-auth integration suite.
 *
 * Boots a real betterAuth() instance with ledgerPlugin, createSoftDeleteCallback,
 * and the sign-in gate recipe from docs/better-auth.mdx, over drizzleAdapter on an
 * in-memory node:sqlite database. Every flow goes through auth.handler as an HTTP
 * Request, wrapped in the ledger-context middleware the docs require, so a changed
 * hook signature, merge rule, or route behavior in better-auth fails here.
 *
 * Runs against the better-auth in devDependencies; CI also runs it against the
 * floor and the latest of the declared peer range.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { admin, testUtils } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createSoftDeleteCallback, ledgerPlugin } from "../src/better-auth.js";
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

const account = sqliteTable("account", {
  id: text("id").primaryKey(),
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

  const auth = betterAuth({
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
      deleteUser: {
        enabled: true,
        beforeDelete: createSoftDeleteCallback({
          db,
          userTable: user,
          whereUserId: (userId) => eq(user.id, userId),
          // The docs recipe, verbatim: feature-detect the mid-1.6 split.
          revokeSessions: async (userId) => {
            const ctx = await auth.$context;
            const ia = ctx.internalAdapter as {
              deleteUserSessions?: (userId: string) => Promise<void>;
              deleteSessions: (value: string | string[]) => Promise<void>;
            };
            if (ia.deleteUserSessions) {
              await ia.deleteUserSessions(userId);
            } else {
              await ia.deleteSessions(userId);
            }
          },
          writeAuditEntry,
        }),
      },
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
      ledgerPlugin({ auditTables: ["user", "account"], writeAuditEntry }),
      admin(),
      testUtils(),
    ],
  });

  /**
   * The ledger-context middleware from the docs, in front of auth.handler:
   * resolve the authenticated principal, then run the request inside it.
   */
  async function handle(request: Request): Promise<Response> {
    const current = await auth.api.getSession({ headers: request.headers });
    const url = new URL(request.url);
    return runWithLedgerContext(
      createLedgerContext({
        userId: current?.user.id ?? null,
        endpoint: `${request.method} ${url.pathname}`,
      }),
      () => auth.handler(request),
    );
  }

  function post(path: string, body: Record<string, unknown>, headers?: Headers): Promise<Response> {
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
      });
      linkedAccountId = linked.id;

      const response = await post("/unlink-account", { providerId: "github" }, memberHeaders);
      expect(response.status).toBe(200);
      const rows = await db.select().from(account).where(eq(account.id, linkedAccountId));
      expect(rows).toHaveLength(0);
    });

    // Fails until the delete hooks land (#45): the plugin registers no
    // account delete hook, so an unlink leaves no audit trace.
    test.fails("unlinking records a DELETE entry for the account (#45)", async () => {
      const deletes = (await auditRows()).filter(
        (e) => e.tableName === "account" && e.recordId === linkedAccountId && e.action === "DELETE",
      );
      expect(deletes).toHaveLength(1);
    });
  });

  describe("self-service delete over auth.handler", () => {
    test("soft-deletes the user, revokes every session, and audits SOFT_DELETE", async () => {
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
    });

    // Fails until #44: createSoftDeleteCallback throws SoftDeletePerformedError
    // to stop the hard delete, and better-auth answers the throw with a 500.
    test.fails("answers the browser with 200 (#44)", () => {
      expect(deleteResponse?.status).toBe(200);
    });
  });

  test("sign-in on the soft-deleted user is rejected by the gate", async () => {
    const response = await post("/sign-in/email", {
      email: member.email,
      password: member.password,
    });
    expect(response.status).toBe(403);
    const sessions = await db.select().from(session).where(eq(session.userId, memberId));
    expect(sessions).toHaveLength(0);
  });

  test("purgeUserData anonymizes every row the flows produced", async () => {
    const result = await purgeUserData(db, auditLog, memberId);
    expect(result.entriesSkipped).toBe(0);
    expect(result.entriesAnonymized).toBeGreaterThanOrEqual(3);

    const rows = await auditRows();
    const aboutMember = rows.filter((e) => e.recordId === memberId);
    expect(aboutMember.length).toBe(result.entriesAnonymized);
    for (const entry of aboutMember) {
      expect(entry.oldData ?? "").not.toContain(member.email);
      expect(entry.newData ?? "").not.toContain(member.email);
    }
    // Self-performed entries lose the identifier; the admin's keeps the admin.
    for (const entry of aboutMember.filter((e) => e.action !== "UPDATE")) {
      expect(entry.userId).toBe("PURGED_USER");
    }
    expect(aboutMember.find((e) => e.action === "UPDATE")?.userId).toBe(adminId);

    expect(rows.filter((e) => e.action === "PURGE")).toHaveLength(1);
    expect(await isUserDataPurged(db, auditLog, memberId)).toBe(true);
  });
});
