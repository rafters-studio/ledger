import { describe, expect, test, vi } from "vitest";
import { createLedgerContext, runWithLedgerContext } from "../src/core/context.js";
import {
  createDeleteAuditCallback,
  type LedgerAuditEntry,
  ledgerPlugin,
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
    // account is opt-in since the redaction/default change: its rows
    // carry OAuth tokens and are not audited unless explicitly listed
    expect(result?.options?.databaseHooks?.account).toBeUndefined();
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

    // Simulate user update with no ledger context and no before hook
    await userHooks?.update?.after?.({ id: "user-456", email: "updated@test.com" });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tableName: "user",
      recordId: "user-456",
      action: "UPDATE",
      oldData: null,
      // Actor unknown without context -- NEVER the target row's id
      userId: null,
    });
  });

  test("update attributes to the authenticated actor from ledger context", async () => {
    const entries: LedgerAuditEntry[] = [];
    const plugin = ledgerPlugin({
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
    const userHooks = result?.options?.databaseHooks?.user;

    await runWithLedgerContext(createLedgerContext({ userId: "admin-1" }), async () => {
      await userHooks?.update?.after?.({ id: "user-456", banned: true });
    });

    expect(entries).toHaveLength(1);
    // Admin banning a user is recorded as the admin acting, not the target
    expect(entries[0]?.userId).toBe("admin-1");
    expect(entries[0]?.recordId).toBe("user-456");
  });

  test("the hook context's session user wins over the ledger context (#46)", async () => {
    const entries: LedgerAuditEntry[] = [];
    const plugin = ledgerPlugin({
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
    const userHooks = result?.options?.databaseHooks?.user;
    const hookCtx = { context: { session: { user: { id: "session-admin" } } } };

    await runWithLedgerContext(createLedgerContext({ userId: "ledger-actor" }), async () => {
      await userHooks?.update?.after?.({ id: "user-456", banned: true }, hookCtx);
    });
    // No session on the hook context: the ledger context is next.
    await runWithLedgerContext(createLedgerContext({ userId: "ledger-actor" }), async () => {
      await userHooks?.update?.after?.({ id: "user-456" }, { context: { session: null } });
    });
    // Neither: the self-signup fallback still applies on user create.
    await userHooks?.create?.after?.({ id: "user-new" }, { context: { session: null } });

    expect(entries.map((e) => e.userId)).toEqual(["session-admin", "ledger-actor", "user-new"]);
  });

  test("update change sets pair on the hook context without a ledger context (#46)", async () => {
    const entries: LedgerAuditEntry[] = [];
    const plugin = ledgerPlugin({
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
    const userHooks = result?.options?.databaseHooks?.user;
    const requestA = { context: { session: { user: { id: "actor-a" } } } };
    const requestB = { context: { session: { user: { id: "actor-b" } } } };

    await userHooks?.update?.before?.({ name: "change-A" }, requestA);
    await userHooks?.update?.before?.({ name: "change-B" }, requestB);
    await userHooks?.update?.after?.({ id: "user-b", name: "change-B" }, requestB);
    await userHooks?.update?.after?.({ id: "user-a", name: "change-A" }, requestA);

    expect(entries.find((e) => e.recordId === "user-a")).toMatchObject({
      oldData: { changed: { name: "change-A" } },
      userId: "actor-a",
    });
    expect(entries.find((e) => e.recordId === "user-b")).toMatchObject({
      oldData: { changed: { name: "change-B" } },
      userId: "actor-b",
    });
  });

  test("update.before change set is paired into oldData as { changed } within a context", async () => {
    const entries: LedgerAuditEntry[] = [];
    const plugin = ledgerPlugin({
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
    const userHooks = result?.options?.databaseHooks?.user;

    await runWithLedgerContext(createLedgerContext({ userId: "admin-1" }), async () => {
      await userHooks?.update?.before?.({ name: "New Name" });
      await userHooks?.update?.after?.({ id: "user-9", name: "New Name", email: "e@test.com" });
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.oldData).toEqual({ changed: { name: "New Name" } });
    expect(entries[0]?.newData).toMatchObject({ id: "user-9", name: "New Name" });
  });

  test("update.before returns nothing -- never echoes data back into the hook merge", async () => {
    const plugin = ledgerPlugin({ writeAuditEntry: () => Promise.resolve() });
    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
    const userHooks = result?.options?.databaseHooks?.user;

    // better-auth merges a hook's returned data over the accumulated
    // payload; returning { data } would revert other hooks' mutations.
    const returned = await runWithLedgerContext(
      createLedgerContext({ userId: "admin-1" }),
      async () => userHooks?.update?.before?.({ name: "X" }),
    );

    expect(returned).toBeUndefined();
  });

  test("concurrent contexts never cross-pair change sets", async () => {
    const entries: LedgerAuditEntry[] = [];
    const plugin = ledgerPlugin({
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
    const userHooks = result?.options?.databaseHooks?.user;

    const ctxA = createLedgerContext({ userId: "actor-a" });
    const ctxB = createLedgerContext({ userId: "actor-b" });

    // Interleave: both befores run, then the afters resolve in REVERSE
    // order (B's DB write finishes first) -- the plugin-lifetime FIFO
    // this replaces would have paired B's entry with A's change set.
    await runWithLedgerContext(ctxA, async () => {
      await userHooks?.update?.before?.({ name: "change-A" });
    });
    await runWithLedgerContext(ctxB, async () => {
      await userHooks?.update?.before?.({ name: "change-B" });
    });
    await runWithLedgerContext(ctxB, async () => {
      await userHooks?.update?.after?.({ id: "user-b", name: "change-B" });
    });
    await runWithLedgerContext(ctxA, async () => {
      await userHooks?.update?.after?.({ id: "user-a", name: "change-A" });
    });

    expect(entries).toHaveLength(2);
    const entryB = entries.find((e) => e.recordId === "user-b");
    const entryA = entries.find((e) => e.recordId === "user-a");
    expect(entryB?.oldData).toEqual({ changed: { name: "change-B" } });
    expect(entryB?.userId).toBe("actor-b");
    expect(entryA?.oldData).toEqual({ changed: { name: "change-A" } });
    expect(entryA?.userId).toBe("actor-a");
  });

  test("databaseHooks for account calls writeAuditEntry when opted in", async () => {
    const entries: LedgerAuditEntry[] = [];
    const plugin = ledgerPlugin({
      auditTables: ["user", "account"],
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
    const userHooks = result?.options?.databaseHooks?.user;

    // Request 1: before fires but the update fails/is vetoed -- after
    // never runs. The capture is stranded in request 1's context only.
    await runWithLedgerContext(createLedgerContext({ userId: "actor-1" }), async () => {
      await userHooks?.update?.before?.({ name: "doomed-change" });
    });

    // Request 2: a fresh context pairs its own change set correctly.
    await runWithLedgerContext(createLedgerContext({ userId: "actor-2" }), async () => {
      await userHooks?.update?.before?.({ name: "clean-change" });
      await userHooks?.update?.after?.({ id: "user-2", name: "clean-change" });
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.oldData).toEqual({ changed: { name: "clean-change" } });
    expect(entries[0]?.oldData).not.toEqual({ changed: { name: "doomed-change" } });
  });

  test("update hooks without any ledger context capture nothing and pair nothing", async () => {
    const entries: LedgerAuditEntry[] = [];
    const plugin = ledgerPlugin({
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
    const userHooks = result?.options?.databaseHooks?.user;

    await userHooks?.update?.before?.({ name: "uncaptured" });
    await userHooks?.update?.after?.({ id: "user-n", name: "uncaptured" });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.oldData).toBeNull();
  });

  test("create with an authenticated context attributes to the context actor", async () => {
    const entries: LedgerAuditEntry[] = [];
    const plugin = ledgerPlugin({
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
    const userHooks = result?.options?.databaseHooks?.user;

    await runWithLedgerContext(createLedgerContext({ userId: "admin-1" }), async () => {
      await userHooks?.create?.after?.({ id: "user-new", email: "n@test.com" });
    });

    // Admin-created user attributes to the admin; self-signup fallback
    // applies only when no context exists
    expect(entries[0]?.userId).toBe("admin-1");
  });

  test("databaseHooks for account calls writeAuditEntry when opted in", async () => {
    const entries: LedgerAuditEntry[] = [];
    const plugin = ledgerPlugin({
      auditTables: ["user", "account"],
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

  test("registers only delete.after and no deleteUser option without softDeleteUser", () => {
    const plugin = ledgerPlugin();

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);

    expect(result?.options?.databaseHooks?.user?.delete?.before).toBeUndefined();
    expect(result?.options?.databaseHooks?.user?.delete?.after).toBeDefined();
    expect(result?.options?.user).toBeUndefined();
  });

  describe("delete.after", () => {
    function hooksFor(auditTables: ("user" | "account" | "session" | "verification")[]) {
      const entries: LedgerAuditEntry[] = [];
      const plugin = ledgerPlugin({
        auditTables,
        writeAuditEntry: (entry) => {
          entries.push(entry);
          return Promise.resolve();
        },
      });
      const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
      return { hooks: result?.options?.databaseHooks, entries };
    }

    test("a hard user delete writes one DELETE entry with the row as oldData", async () => {
      const { hooks, entries } = hooksFor(["user"]);

      await hooks?.user?.delete?.after?.({ id: "user-9", email: "gone@test.com" }, null);

      expect(entries).toEqual([
        {
          tableName: "user",
          recordId: "user-9",
          action: "DELETE",
          oldData: { id: "user-9", email: "gone@test.com" },
          newData: null,
          userId: "user-9",
        },
      ]);
    });

    test("an account delete is redacted and attributed to the context actor", async () => {
      const { hooks, entries } = hooksFor(["account"]);

      await runWithLedgerContext(createLedgerContext({ userId: "user-1" }), () =>
        hooks?.account?.delete?.after?.(
          {
            id: "acc-1",
            userId: "user-1",
            providerId: "github",
            accessToken: "gho_secret",
            refreshToken: "ghr_secret",
          },
          null,
        ),
      );

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        tableName: "account",
        recordId: "acc-1",
        action: "DELETE",
        newData: null,
        userId: "user-1",
      });
      expect(entries[0]?.oldData).toMatchObject({ id: "acc-1", providerId: "github" });
      expect(JSON.stringify(entries[0])).not.toContain("_secret");
    });

    test("a session delete (sign-out) is redacted and has no fallback actor", async () => {
      const { hooks, entries } = hooksFor(["session"]);

      await hooks?.session?.delete?.after?.(
        { id: "sess-1", userId: "user-1", token: "session-token-value" },
        null,
      );

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ tableName: "session", action: "DELETE", userId: null });
      expect(JSON.stringify(entries[0])).not.toContain("session-token-value");
    });

    test("session deletes stay unaudited unless session is listed", () => {
      const { hooks } = hooksFor(["user"]);

      expect(hooks?.session).toBeUndefined();
    });
  });

  test("fail-closed: an entry that cannot be redacted is never written", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const writeSpy = vi.fn().mockResolvedValue(undefined);
    const plugin = ledgerPlugin({ writeAuditEntry: writeSpy });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
    const userHooks = result?.options?.databaseHooks?.user;

    // Object.entries invokes getters; a throwing getter makes redaction fail
    const poisoned: Record<string, unknown> = { id: "user-x" };
    Object.defineProperty(poisoned, "boobyTrap", {
      enumerable: true,
      get() {
        throw new Error("redaction cannot read this");
      },
    });

    await expect(userHooks?.create?.after?.(poisoned)).resolves.toBeUndefined();

    expect(writeSpy).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Redaction failed"),
      expect.any(Error),
    );

    consoleSpy.mockRestore();
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

  test("redacts token/secret/password fields from account entries", async () => {
    const entries: LedgerAuditEntry[] = [];
    const plugin = ledgerPlugin({
      auditTables: ["account"],
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
    const accountHooks = result?.options?.databaseHooks?.account;

    await accountHooks?.create?.after?.({
      id: "acc-1",
      userId: "user-1",
      providerId: "github",
      accessToken: "gho_live_access_token",
      refreshToken: "ghr_live_refresh_token",
      idToken: "eyJ_id_token",
      password: "argon2id$hash",
      accessTokenExpiresAt: "2027-01-01",
    });

    expect(entries).toHaveLength(1);
    const serialized = JSON.stringify(entries[0]);
    expect(serialized).not.toContain("gho_live_access_token");
    expect(serialized).not.toContain("ghr_live_refresh_token");
    expect(serialized).not.toContain("eyJ_id_token");
    expect(serialized).not.toContain("argon2id$hash");
    // Non-secret fields survive
    expect(entries[0]?.newData).toMatchObject({ id: "acc-1", providerId: "github" });
    expect(entries[0]?.newData?.accessToken).toBe("[REDACTED]");
  });

  test("redacts the verification value column when verification is audited", async () => {
    const entries: LedgerAuditEntry[] = [];
    const plugin = ledgerPlugin({
      auditTables: ["verification"],
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
    const verificationHooks = result?.options?.databaseHooks?.verification;

    await verificationHooks?.create?.after?.({
      id: "ver-1",
      identifier: "reset-password:user-1",
      value: "otp-482913",
    });

    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0])).not.toContain("otp-482913");
    expect(entries[0]?.newData).toMatchObject({
      id: "ver-1",
      identifier: "reset-password:user-1",
      value: "[REDACTED]",
    });
  });

  test("redaction handles nested payloads and case variants", async () => {
    const entries: LedgerAuditEntry[] = [];
    const plugin = ledgerPlugin({
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
    const userHooks = result?.options?.databaseHooks?.user;

    await userHooks?.create?.after?.({
      id: "user-1",
      profile: { ApiKey: "sk-live-123", nested: [{ CLIENT_SECRET: "shh" }] },
    });

    const serialized = JSON.stringify(entries[0]);
    expect(serialized).not.toContain("sk-live-123");
    expect(serialized).not.toContain("shh");
  });

  test("respects extra redactPatterns", async () => {
    const entries: LedgerAuditEntry[] = [];
    const plugin = ledgerPlugin({
      redactPatterns: ["ssn"],
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });

    const result = plugin.init?.({} as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
    const userHooks = result?.options?.databaseHooks?.user;

    await userHooks?.create?.after?.({ id: "user-1", ssn: "123-45-6789" });

    expect(JSON.stringify(entries[0])).not.toContain("123-45-6789");
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

  test("attributes the delete to the ledger context actor, not the target (#43)", async () => {
    const entries: LedgerAuditEntry[] = [];
    const callback = createDeleteAuditCallback((entry) => {
      entries.push(entry);
      return Promise.resolve();
    });
    const user = {
      id: "user-1",
      email: "x@test.com",
      name: "X",
      createdAt: new Date(),
      updatedAt: new Date(),
      emailVerified: false,
      image: null,
    };

    await runWithLedgerContext(createLedgerContext({ userId: "admin-1" }), () => callback(user));
    await callback(user);

    expect(entries.map((e) => e.userId)).toEqual(["admin-1", "user-1"]);
  });

  test("redacts secret fields in the delete audit entry", async () => {
    const entries: LedgerAuditEntry[] = [];
    const callback = createDeleteAuditCallback((entry) => {
      entries.push(entry);
      return Promise.resolve();
    });

    const user = {
      id: "user-1",
      email: "x@test.com",
      name: "X",
      createdAt: new Date(),
      updatedAt: new Date(),
      emailVerified: false,
      image: null,
      twoFactorSecret: "otp-secret-value",
    };

    await expect(
      callback(user as unknown as Parameters<typeof callback>[0]),
    ).resolves.toBeUndefined();

    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0])).not.toContain("otp-secret-value");
  });

  test("fail-closed: unredactable entry is never written", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const writeSpy = vi.fn().mockResolvedValue(undefined);
    const callback = createDeleteAuditCallback(writeSpy);

    const poisoned: Record<string, unknown> = {
      id: "user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    Object.defineProperty(poisoned, "boobyTrap", {
      enumerable: true,
      get() {
        throw new Error("cannot read");
      },
    });

    await expect(
      callback(poisoned as unknown as Parameters<typeof callback>[0]),
    ).resolves.toBeUndefined();

    expect(writeSpy).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Redaction failed"),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
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

describe("ledgerPlugin softDeleteUser", () => {
  type PluginInit = NonNullable<ReturnType<typeof ledgerPlugin>["init"]>;

  function fakeContext(fields: string[], update = vi.fn().mockResolvedValue(null)) {
    const ctx = {
      tables: { user: { fields: Object.fromEntries(fields.map((f) => [f, { type: "string" }])) } },
      adapter: { update },
    };
    return { ctx: ctx as unknown as Parameters<PluginInit>[0], update };
  }

  function initWith(fields: string[], update?: ReturnType<typeof vi.fn>) {
    const entries: LedgerAuditEntry[] = [];
    const plugin = ledgerPlugin({
      softDeleteUser: true,
      writeAuditEntry: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    });
    const fake = fakeContext(fields, update);
    const result = plugin.init?.(fake.ctx);
    const before = result?.options?.databaseHooks?.user?.delete?.before;
    if (!before) throw new Error("softDeleteUser registered no user delete.before hook");
    return { before, entries, update: fake.update, result };
  }

  const user = {
    id: "user-1",
    email: "x@test.com",
    name: "X",
    createdAt: new Date(),
    updatedAt: new Date(),
    emailVerified: false,
    image: null,
    twoFactorSecret: "otp-secret-value",
  };

  test("sets deletedAt and deletedBy through the adapter and vetoes the row delete", async () => {
    const { before, update } = initWith(["deletedAt", "deletedBy"]);

    await expect(before(user, null)).resolves.toBe(false);

    expect(update).toHaveBeenCalledTimes(1);
    const [call] = update.mock.calls;
    expect(call?.[0]).toMatchObject({
      model: "user",
      where: [{ field: "id", value: "user-1" }],
      update: { deletedBy: null },
    });
    expect(call?.[0].update.deletedAt).toBeInstanceOf(Date);
  });

  test("omits deletedBy when the user schema does not declare it", async () => {
    const { before, update } = initWith(["deletedAt"]);

    await before(user, null);

    expect(Object.keys(update.mock.calls[0]?.[0].update)).toEqual(["deletedAt"]);
  });

  test("writes one redacted SOFT_DELETE entry", async () => {
    const { before, entries } = initWith(["deletedAt"]);

    await before(user, null);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tableName: "user",
      recordId: "user-1",
      action: "SOFT_DELETE",
      userId: "user-1",
    });
    expect(entries[0]?.newData?.deletedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(entries[0])).not.toContain("otp-secret-value");
  });

  test("attributes the entry to the authenticated actor from ledger context", async () => {
    const { before, entries } = initWith(["deletedAt"]);

    await runWithLedgerContext(createLedgerContext({ userId: "admin-1" }), () =>
      before(user, null),
    );

    expect(entries[0]?.userId).toBe("admin-1");
  });

  test("an admin soft-deleting a user records the admin as userId and deletedBy (#43)", async () => {
    const { before, entries, update } = initWith(["deletedAt", "deletedBy"]);

    await runWithLedgerContext(createLedgerContext({ userId: "admin-1" }), () =>
      before(user, null),
    );

    expect(update.mock.calls[0]?.[0].update.deletedBy).toBe("admin-1");
    expect(entries[0]?.userId).toBe("admin-1");
    expect(entries[0]?.newData?.deletedBy).toBe("admin-1");
  });

  test("the hook context's session user is the deletedBy actor (#43)", async () => {
    const { before, entries, update } = initWith(["deletedAt", "deletedBy"]);

    await before(user, { context: { session: { user: { id: "admin-1" } } } });

    expect(update.mock.calls[0]?.[0].update.deletedBy).toBe("admin-1");
    expect(entries[0]?.userId).toBe("admin-1");
  });

  test("self-service with no context records the user as userId and deletedBy null (#43)", async () => {
    const { before, entries, update } = initWith(["deletedAt", "deletedBy"]);

    await before(user, null);

    expect(update.mock.calls[0]?.[0].update.deletedBy).toBeNull();
    expect(entries[0]?.userId).toBe("user-1");
    expect(entries[0]?.newData?.deletedBy).toBeNull();
  });

  test("an adapter failure propagates and writes no entry", async () => {
    const { before, entries } = initWith(
      ["deletedAt"],
      vi.fn().mockRejectedValue(new Error("db down")),
    );

    await expect(before(user, null)).rejects.toThrow("db down");
    expect(entries).toHaveLength(0);
  });

  test("keeps the user create, update, and delete.after audit hooks alongside the delete hook", () => {
    const { result } = initWith(["deletedAt"]);
    const userHooks = result?.options?.databaseHooks?.user;

    expect(userHooks?.create?.after).toBeDefined();
    expect(userHooks?.update?.after).toBeDefined();
    // Never fires for a soft delete: the before hook's veto skips after hooks.
    expect(userHooks?.delete?.after).toBeDefined();
  });

  test("one plugin value initialized twice keeps each hook on its own adapter", async () => {
    const plugin = ledgerPlugin({ softDeleteUser: true });
    const first = fakeContext(["deletedAt"]);
    const second = fakeContext(["deletedAt"]);
    // better-auth keeps the hooks object and looks the hook up at delete time.
    const firstHooks = plugin.init?.(first.ctx)?.options?.databaseHooks;
    plugin.init?.(second.ctx);

    await firstHooks?.user?.delete?.before?.(user, null);

    expect(first.update).toHaveBeenCalledTimes(1);
    expect(second.update).not.toHaveBeenCalled();
  });

  test("init throws when the user schema has no deletedAt field", () => {
    const plugin = ledgerPlugin({ softDeleteUser: true });

    expect(() => plugin.init?.(fakeContext(["deletedBy"]).ctx)).toThrow(/deletedAt/);
  });
});
