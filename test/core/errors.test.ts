import { describe, expect, test } from "vitest";
import {
  AuditTableDeleteError,
  MissingPrimaryKeyError,
  LedgerContextUnavailableError,
  MissingSoftDeleteColumnError,
  MissingSoftDeleteTablesError,
  UnresolvedSoftDeleteTableError,
} from "../../src/core/errors.js";

describe("hardening error classes", () => {
  test("LedgerContextUnavailableError carries its code", () => {
    const error = new LedgerContextUnavailableError();
    expect(error.code).toBe("LEDGER_CONTEXT_UNAVAILABLE");
    expect(error.name).toBe("LedgerContextUnavailableError");
    expect(error.message).toContain("AsyncLocalStorage");
  });

  test("AuditTableDeleteError names the refused table", () => {
    const error = new AuditTableDeleteError("audit_log");
    expect(error.code).toBe("AUDIT_TABLE_DELETE");
    expect(error.tableName).toBe("audit_log");
  });

  test("MissingSoftDeleteTablesError names the migration step", () => {
    const error = new MissingSoftDeleteTablesError();
    expect(error.code).toBe("MISSING_SOFT_DELETE_TABLES");
    expect(error.name).toBe("MissingSoftDeleteTablesError");
    expect(error.message).toContain("softDeleteTables");
  });

  test("MissingPrimaryKeyError names the table without a key", () => {
    const error = new MissingPrimaryKeyError("notes");
    expect(error.code).toBe("MISSING_PRIMARY_KEY");
    expect(error.name).toBe("MissingPrimaryKeyError");
    expect(error.tableName).toBe("notes");
  });

  test("existing error classes unchanged", () => {
    expect(new MissingSoftDeleteColumnError("t").code).toBe("MISSING_SOFT_DELETE_COLUMN");
    expect(new UnresolvedSoftDeleteTableError().code).toBe("UNRESOLVED_SOFT_DELETE_TABLE");
  });
});
