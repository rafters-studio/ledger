import { describe, expect, test } from "vitest";
import { isSoftDeleted, restoreValues, softDeleteValues } from "../../src/core/soft-delete.js";

describe("softDeleteValues", () => {
  test("returns current timestamp and null deletedBy", () => {
    const values = softDeleteValues();
    expect(values.deletedAt).toBeInstanceOf(Date);
    expect(values.deletedBy).toBeNull();
  });

  test("includes deletedBy when provided", () => {
    const values = softDeleteValues("user-123");
    expect(values.deletedAt).toBeInstanceOf(Date);
    expect(values.deletedBy).toBe("user-123");
  });

  test("handles null deletedBy", () => {
    const values = softDeleteValues(null);
    expect(values.deletedBy).toBeNull();
  });
});

describe("restoreValues", () => {
  test("returns null for both fields", () => {
    const values = restoreValues();
    expect(values.deletedAt).toBeNull();
    expect(values.deletedBy).toBeNull();
  });
});

describe("isSoftDeleted", () => {
  test("returns true for deleted record", () => {
    expect(isSoftDeleted({ deletedAt: new Date() })).toBe(true);
  });

  test("returns false for active record", () => {
    expect(isSoftDeleted({ deletedAt: null })).toBe(false);
  });

  test("returns false for null/undefined", () => {
    expect(isSoftDeleted(null)).toBe(false);
    expect(isSoftDeleted(undefined)).toBe(false);
  });
});
