import { describe, expect, test } from "vitest";
import {
  AuditTableDeleteError,
  isSoftDeletePerformed,
  LedgerContextUnavailableError,
  MissingSoftDeleteColumnError,
  MissingSoftDeleteTablesError,
  SoftDeletePerformedError,
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

  test("existing error classes unchanged", () => {
    expect(new SoftDeletePerformedError("u1").code).toBe("SOFT_DELETE_PERFORMED");
    expect(new MissingSoftDeleteColumnError("t").code).toBe("MISSING_SOFT_DELETE_COLUMN");
    expect(new UnresolvedSoftDeleteTableError().code).toBe("UNRESOLVED_SOFT_DELETE_TABLE");
  });

  test("isSoftDeletePerformed still duck-types in-process errors only by shape", () => {
    const spoof = new Error("spoof");
    (spoof as Error & { code: string }).code = "SOFT_DELETE_PERFORMED";
    (spoof as Error & { softDeleted: boolean }).softDeleted = true;
    // Spoofable by in-process code BY DESIGN -- the docblock draws the
    // trust boundary; this pins that the check is shape-based.
    expect(isSoftDeletePerformed(spoof)).toBe(true);
  });
});
