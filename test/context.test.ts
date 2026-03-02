import { describe, expect, test } from "vitest";
import {
  createLedgerContext,
  createSystemContext,
  getLedgerContext,
  hasLedgerContext,
  runWithLedgerContext,
} from "../src/context.js";

describe("createLedgerContext", () => {
  test("creates context with all fields", () => {
    const ctx = createLedgerContext({
      userId: "user-123",
      ip: "1.2.3.4",
      userAgent: "Mozilla/5.0",
      endpoint: "POST /api/mods",
      requestId: "req-456",
      metadata: { foo: "bar" },
    });

    expect(ctx.userId).toBe("user-123");
    expect(ctx.ip).toBe("1.2.3.4");
    expect(ctx.userAgent).toBe("Mozilla/5.0");
    expect(ctx.endpoint).toBe("POST /api/mods");
    expect(ctx.requestId).toBe("req-456");
    expect(ctx.metadata).toEqual({ foo: "bar" });
  });

  test("defaults missing fields to null", () => {
    const ctx = createLedgerContext({});

    expect(ctx.userId).toBeNull();
    expect(ctx.ip).toBeNull();
    expect(ctx.userAgent).toBeNull();
    expect(ctx.endpoint).toBeNull();
    expect(ctx.requestId).toBeUndefined();
    expect(ctx.metadata).toBeUndefined();
  });
});

describe("createSystemContext", () => {
  test("creates context with system endpoint", () => {
    const ctx = createSystemContext("cron:cleanup");

    expect(ctx.userId).toBeNull();
    expect(ctx.ip).toBeNull();
    expect(ctx.endpoint).toBe("system:cron:cleanup");
  });

  test("includes metadata if provided", () => {
    const ctx = createSystemContext("migration:v2", { version: 2 });

    expect(ctx.metadata).toEqual({ version: 2 });
  });
});

describe("runWithLedgerContext", () => {
  test("context available inside callback", () => {
    const context = createLedgerContext({ userId: "user-123" });

    runWithLedgerContext(context, () => {
      const retrieved = getLedgerContext();
      expect(retrieved?.userId).toBe("user-123");
    });
  });

  test("context flows through async operations", async () => {
    const context = createLedgerContext({ userId: "user-456", ip: "5.6.7.8" });

    await runWithLedgerContext(context, async () => {
      await new Promise((r) => setTimeout(r, 10));
      const retrieved = getLedgerContext();
      expect(retrieved?.userId).toBe("user-456");
      expect(retrieved?.ip).toBe("5.6.7.8");
    });
  });

  test("returns callback result", () => {
    const context = createLedgerContext({});
    const result = runWithLedgerContext(context, () => 42);
    expect(result).toBe(42);
  });

  test("returns async callback result", async () => {
    const context = createLedgerContext({});
    const result = await runWithLedgerContext(context, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "async-result";
    });
    expect(result).toBe("async-result");
  });
});

describe("getLedgerContext", () => {
  test("returns null outside context", () => {
    expect(getLedgerContext()).toBeNull();
  });
});

describe("hasLedgerContext", () => {
  test("returns false outside context", () => {
    expect(hasLedgerContext()).toBe(false);
  });

  test("returns true inside context", () => {
    const context = createLedgerContext({});
    runWithLedgerContext(context, () => {
      expect(hasLedgerContext()).toBe(true);
    });
  });
});
