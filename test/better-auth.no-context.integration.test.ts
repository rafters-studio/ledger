/**
 * better-auth integration without ledger context (#46).
 *
 * Ledger's context storage is unavailable (no AsyncLocalStorage global), and
 * requests reach auth.handler with no runWithLedgerContext middleware.
 * better-auth keeps its own endpoint context (it imports node:async_hooks
 * itself), and attribution must come from the hook context it hands every
 * databaseHook.
 */

import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin, testUtils } from "better-auth/plugins";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type LedgerAuditEntry, ledgerPlugin } from "../src/better-auth.js";
import { assertLedgerContextAvailable } from "../src/core/context.js";

// test/setup.ts installs the global for every file; this file runs without it.
// ledger reads the global lazily, on its first context access.
Reflect.deleteProperty(globalThis, "AsyncLocalStorage");

const BASE_URL = "http://localhost:3000";

describe("better-auth integration: no AsyncLocalStorage, no ledger middleware", () => {
  const sqlite = new DatabaseSync(":memory:");
  const entries: LedgerAuditEntry[] = [];

  const auth = betterAuth({
    baseURL: BASE_URL,
    secret: "ledger-no-context-secret-that-is-long-enough-for-validation",
    database: sqlite,
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    logger: { disabled: true },
    plugins: [
      ledgerPlugin({
        writeAuditEntry: async (entry) => {
          entries.push(entry);
        },
      }),
      admin(),
      testUtils(),
    ],
  });

  /** POST straight to auth.handler: no middleware in front of it. */
  function post(path: string, body: Record<string, unknown>, headers?: Headers) {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("content-type", "application/json");
    requestHeaders.set("origin", BASE_URL);
    return auth.handler(
      new Request(`${BASE_URL}/api/auth${path}`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
      }),
    );
  }

  beforeAll(async () => {
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
  });

  afterAll(() => {
    sqlite.close();
  });

  test("ledger context is unavailable in this runtime", () => {
    expect(() => assertLedgerContextAvailable()).toThrow();
  });

  test("an admin updating a user writes an UPDATE attributed to the admin", async () => {
    const signUp = await post("/sign-up/email", {
      email: "member@example.com",
      password: "member-password-123",
      name: "Member",
    });
    expect(signUp.status).toBe(200);
    const memberId = ((await signUp.json()) as { user: { id: string } }).user.id;

    const ctx = await auth.$context;
    const adminUser = await ctx.test.saveUser(
      ctx.test.createUser({ email: "admin@example.com", name: "Admin", role: "admin" }),
    );
    const { headers } = await ctx.test.login({ userId: adminUser.id });

    const response = await post(
      "/admin/update-user",
      { userId: memberId, data: { name: "Renamed By Admin" } },
      headers,
    );
    expect(response.status).toBe(200);

    const updates = entries.filter(
      (e) => e.tableName === "user" && e.recordId === memberId && e.action === "UPDATE",
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.userId).toBe(adminUser.id);
    expect(updates[0]?.newData).toMatchObject({ name: "Renamed By Admin" });
    // The change set pairs on the hook context, without a ledger context.
    expect(updates[0]?.oldData).toMatchObject({ changed: { name: "Renamed By Admin" } });
  });
});
