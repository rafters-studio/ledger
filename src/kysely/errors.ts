/**
 * Kysely plugin errors.
 */

/** A write reached the plugin before it finished reading the database schema. */
export class LedgerNotReadyError extends Error {
  readonly code = "LEDGER_NOT_READY" as const;

  constructor(cause?: unknown) {
    super(
      "ledger has not finished reading the database schema; await plugin.ready() before the first write",
      cause === undefined ? undefined : { cause },
    );
    this.name = "LedgerNotReadyError";
  }
}

/** A write targeted a table that was not in the schema the plugin read. */
export class LedgerUnknownTableError extends Error {
  readonly code = "LEDGER_UNKNOWN_TABLE" as const;
  readonly table: string;

  constructor(table: string) {
    super(
      `ledger does not know table "${table}": it was not in the schema read at startup. Create tables before the plugin loads, or call plugin.refresh() after a migration.`,
    );
    this.name = "LedgerUnknownTableError";
    this.table = table;
  }
}

/** A raw SQL DELETE targeted a table that soft-deletes. */
export class LedgerRawDeleteError extends Error {
  readonly code = "LEDGER_RAW_DELETE" as const;
  readonly table: string;

  constructor(table: string) {
    super(
      `raw SQL DELETE on "${table}" refused: the table has a deleted_at column and soft-deletes. Use the query builder's deleteFrom().`,
    );
    this.name = "LedgerRawDeleteError";
    this.table = table;
  }
}

/** The audit table is missing from the database. */
export class LedgerAuditTableMissingError extends Error {
  readonly code = "LEDGER_AUDIT_TABLE_MISSING" as const;
  readonly table: string;

  constructor(table: string) {
    super(
      `audit table "${table}" does not exist; apply @rafters/ledger/sql/sqlite/audit.sql in a migration`,
    );
    this.name = "LedgerAuditTableMissingError";
    this.table = table;
  }
}

/** The statement shape cannot be audited, so it is refused instead of run unaudited. */
export class LedgerUnsupportedStatementError extends Error {
  readonly code = "LEDGER_UNSUPPORTED_STATEMENT" as const;

  constructor(reason: string) {
    super(`ledger cannot audit this statement: ${reason}`);
    this.name = "LedgerUnsupportedStatementError";
  }
}
