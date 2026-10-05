/**
 * Ledger Errors
 *
 * ORM-agnostic error types used across the library.
 */

/**
 * Error thrown when soft-delete is performed successfully.
 * Check for this error type to handle soft-delete success cases.
 */
export class SoftDeletePerformedError extends Error {
  readonly code = "SOFT_DELETE_PERFORMED" as const;
  readonly softDeleted = true as const;
  readonly userId: string;

  constructor(userId: string) {
    super("User soft-deleted successfully");
    this.name = "SoftDeletePerformedError";
    this.userId = userId;
  }
}

/**
 * Check if an error is a soft-delete success error.
 *
 * TRUST BOUNDARY: this duck-types on `code` and `softDeleted` so the
 * check survives cross-realm and multi-copy module setups where
 * instanceof fails. That makes it spoofable BY DESIGN -- but only by
 * code already running inside your process. Never apply it to errors
 * that originate from client-supplied data; treating an
 * attacker-shaped object as "delete succeeded" is on the caller.
 *
 * @param error - The error to check
 * @returns true if this is a soft-delete success
 *
 * @example
 * ```typescript
 * try {
 *   await auth.api.deleteUser({ userId });
 * } catch (error) {
 *   if (isSoftDeletePerformed(error)) {
 *     // Success! User was soft-deleted
 *     return { success: true };
 *   }
 *   throw error;
 * }
 * ```
 */
export function isSoftDeletePerformed(error: unknown): error is SoftDeletePerformedError {
  if (error instanceof SoftDeletePerformedError) return true;
  if (error instanceof Error) {
    return (
      "code" in error &&
      (error as Error & { code?: string }).code === "SOFT_DELETE_PERFORMED" &&
      "softDeleted" in error &&
      (error as Error & { softDeleted?: boolean }).softDeleted === true
    );
  }
  return false;
}

/**
 * Error thrown by createAuditedDb when a table listed
 * in softDeleteTables is deleted from but has no deletedAt property.
 * Loud failure instead of a silent fallback to hard delete.
 */
export class MissingSoftDeleteColumnError extends Error {
  readonly code = "MISSING_SOFT_DELETE_COLUMN" as const;
  readonly tableName: string;

  constructor(tableName: string) {
    super(
      `Table '${tableName}' is listed in softDeleteTables but has no deletedAt column property`,
    );
    this.name = "MissingSoftDeleteColumnError";
    this.tableName = tableName;
  }
}

/**
 * Error thrown by createAuditedDb at the first delete when the config
 * carries no softDeleteTables array (an untyped caller, or a cast past
 * the required type). The wrapper refuses to guess which tables
 * soft-delete, because a wrong guess hard-deletes silently.
 */
export class MissingSoftDeleteTablesError extends Error {
  readonly code = "MISSING_SOFT_DELETE_TABLES" as const;

  constructor() {
    super(
      "createAuditedDb requires softDeleteTables: pass the soft-delete table names (or [] for none) in its config",
    );
    this.name = "MissingSoftDeleteTablesError";
  }
}

/**
 * Error thrown by createAuditedDb when the table
 * object's name cannot be resolved: the allowlist cannot be consulted,
 * and silently falling through to hard delete would defeat the mode.
 */
export class UnresolvedSoftDeleteTableError extends Error {
  readonly code = "UNRESOLVED_SOFT_DELETE_TABLE" as const;

  constructor() {
    super(
      "Cannot resolve the table name for a delete checked against softDeleteTables; refusing to guess between soft and hard delete",
    );
    this.name = "UnresolvedSoftDeleteTableError";
  }
}

/**
 * Error thrown by assertLedgerContextAvailable when AsyncLocalStorage
 * is missing from the runtime: ledger context (and with it audit
 * attribution and deletedBy stamping) cannot function.
 */
export class LedgerContextUnavailableError extends Error {
  readonly code = "LEDGER_CONTEXT_UNAVAILABLE" as const;

  constructor() {
    super(
      "AsyncLocalStorage is not available in this runtime; ledger context cannot function and audit entries would be unattributed",
    );
    this.name = "LedgerContextUnavailableError";
  }
}

/**
 * Error thrown by createAuditedDb when a delete targets the audit log
 * table: the trail must not be wipeable through ledger's own APIs.
 * Pair with AUDIT_LOG_PROTECT_SQL for engine-level enforcement.
 */
export class AuditTableDeleteError extends Error {
  readonly code = "AUDIT_TABLE_DELETE" as const;
  readonly tableName: string;

  constructor(tableName: string) {
    super(`Refusing to delete from audit table '${tableName}' through the audited db wrapper`);
    this.name = "AuditTableDeleteError";
    this.tableName = tableName;
  }
}
