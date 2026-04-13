/**
 * Type-level test: Drizzle adapter satisfies LedgerAdapter interface.
 *
 * This file verifies structural compatibility at compile time.
 * If the Drizzle adapter drifts from the interface, this file
 * will produce a type error -- no runtime assertions needed.
 */

import type { SQL } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import type { LedgerAdapter } from "../../src/core/adapter.js";
import { insertAuditEntry, getRecordHistory } from "../../src/drizzle/audit.js";
import { createAuditedDb } from "../../src/drizzle/db.js";
import { purgeUserData, isUserDataPurged } from "../../src/drizzle/gdpr.js";
import { notDeleted, onlyDeleted } from "../../src/drizzle/soft-delete.js";
import type { AuditLog } from "../../src/drizzle/schema/sqlite.js";

// -- Structural db type covering all Drizzle adapter function requirements --
// Each function uses a slightly different duck-typed db shape. This union
// represents the minimal surface a Drizzle db instance exposes.
type DrizzleDb = {
  insert: (table: AuditLog) => {
    values: (entry: unknown) => { execute: () => Promise<unknown> };
  };
  select: () => {
    from: (table: AuditLog) => {
      where: (condition: unknown) => {
        orderBy: (order: unknown) => Promise<Array<AuditLog["$inferSelect"]>>;
      };
    };
  };
  update: (table: unknown) => {
    set: (values: Record<string, unknown>) => {
      where: (condition: unknown) => {
        returning: () => {
          execute: () => Promise<unknown>;
        };
        execute: () => Promise<unknown>;
      };
    };
  };
  delete: (table: unknown) => {
    where: (condition: unknown) => {
      returning: () => {
        execute: () => Promise<unknown>;
      };
      execute: () => Promise<unknown>;
    };
  };
};

// -- Build the adapter object from standalone Drizzle functions --
const drizzleAdapter = {
  notDeleted,
  onlyDeleted,
  insertAuditEntry,
  getRecordHistory,
  purgeUserData,
  isUserDataPurged,
  createAuditedDb,
} satisfies LedgerAdapter<DrizzleDb, AuditLog, SQL>;

// Alternate verification: assignment check
const _check: LedgerAdapter<DrizzleDb, AuditLog, SQL> = drizzleAdapter;

describe("LedgerAdapter interface", () => {
  test("Drizzle adapter structurally satisfies the interface", () => {
    // The real verification is the type-level satisfies/assignment above.
    // If this file compiles, the adapter conforms.
    expect(drizzleAdapter).toBeDefined();
    expect(drizzleAdapter.notDeleted).toBeTypeOf("function");
    expect(drizzleAdapter.onlyDeleted).toBeTypeOf("function");
    expect(drizzleAdapter.insertAuditEntry).toBeTypeOf("function");
    expect(drizzleAdapter.getRecordHistory).toBeTypeOf("function");
    expect(drizzleAdapter.purgeUserData).toBeTypeOf("function");
    expect(drizzleAdapter.isUserDataPurged).toBeTypeOf("function");
    expect(drizzleAdapter.createAuditedDb).toBeTypeOf("function");
  });

  test("adapter object has exactly the interface methods", () => {
    const keys = Object.keys(drizzleAdapter).sort();
    expect(keys).toEqual([
      "createAuditedDb",
      "getRecordHistory",
      "insertAuditEntry",
      "isUserDataPurged",
      "notDeleted",
      "onlyDeleted",
      "purgeUserData",
    ]);
  });
});
