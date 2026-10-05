/**
 * Ledger Errors
 *
 * ORM-agnostic error types used across the library.
 */

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
 * Error thrown by createAuditedDb when it audits a soft delete on a
 * table that declares no primary key: the audit entries carry one
 * recordId per affected row, and without a key there is no id to write.
 */
export class MissingPrimaryKeyError extends Error {
  readonly code = "MISSING_PRIMARY_KEY" as const;
  readonly tableName: string;

  constructor(tableName: string) {
    super(
      `Table '${tableName}' declares no primary key; createAuditedDb cannot record which rows a soft delete changed`,
    );
    this.name = "MissingPrimaryKeyError";
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
