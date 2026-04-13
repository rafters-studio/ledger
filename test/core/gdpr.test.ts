import { describe, expect, test } from "vitest";
import { anonymizeJsonData } from "../../src/core/gdpr.js";

describe("anonymizeJsonData", () => {
  test("removes specified PII fields", () => {
    const data = { id: "123", email: "test@test.com", name: "John", role: "admin" };
    const result = anonymizeJsonData(data, ["email", "name"]);

    expect(result).toEqual({ id: "123", role: "admin" });
  });

  test("handles null input", () => {
    expect(anonymizeJsonData(null, ["email"])).toBeNull();
  });

  test("handles nested objects", () => {
    const data = { user: { email: "test@test.com", id: "123" } };
    const result = anonymizeJsonData(data, ["email"]);

    expect(result).toEqual({ user: { id: "123" } });
  });

  test("handles deeply nested objects", () => {
    const data = {
      level1: {
        level2: {
          email: "deep@test.com",
          keepMe: "value",
        },
      },
    };
    const result = anonymizeJsonData(data, ["email"]);

    expect(result).toEqual({
      level1: {
        level2: {
          keepMe: "value",
        },
      },
    });
  });

  test("handles arrays of objects", () => {
    const data = {
      users: [
        { id: "1", email: "a@test.com" },
        { id: "2", email: "b@test.com" },
      ],
    };
    const result = anonymizeJsonData(data, ["email"]);

    expect(result).toEqual({
      users: [{ id: "1" }, { id: "2" }],
    });
  });

  test("handles arrays of primitives", () => {
    const data = { tags: ["tag1", "tag2"], email: "remove@test.com" };
    const result = anonymizeJsonData(data, ["email"]);

    expect(result).toEqual({ tags: ["tag1", "tag2"] });
  });

  test("handles empty object", () => {
    expect(anonymizeJsonData({}, ["email"])).toEqual({});
  });

  test("preserves non-PII fields", () => {
    const data = {
      id: "user-123",
      createdAt: "2024-01-01",
      role: "admin",
      email: "remove@test.com",
    };
    const result = anonymizeJsonData(data, ["email"]);

    expect(result).toEqual({
      id: "user-123",
      createdAt: "2024-01-01",
      role: "admin",
    });
  });

  test("handles mixed nested and top-level PII", () => {
    const data = {
      email: "top@test.com",
      profile: {
        name: "John",
        address: "123 Street",
        settings: {
          phone: "555-1234",
          theme: "dark",
        },
      },
    };
    const result = anonymizeJsonData(data, ["email", "name", "address", "phone"]);

    expect(result).toEqual({
      profile: {
        settings: {
          theme: "dark",
        },
      },
    });
  });
});
