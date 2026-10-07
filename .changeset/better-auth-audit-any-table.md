---
"@rafters/ledger": minor
---

`ledgerPlugin` audits any model in the better-auth schema, core or plugin, and writes each audit row in the same database transaction as the change. `auditTables` takes any model name and a name that is not in the schema throws at init. Set `auditTables` without `writeAuditEntry` and the plugin wraps better-auth's adapter so the change and its row in the new `ledger_audit_log` table (the `ledgerAudit` model, created by better-auth's migrations) commit or roll back together: a failed audit write fails the change. Entries carry the actor, a true before-image in `oldData`, and `subjectUserId`, the user the change concerns. Init throws on an adapter without real transactions (D1, or drizzleAdapter without `transaction: true`). The `writeAuditEntry` callback path is unchanged. `DEFAULT_SECRET_PATTERNS` gains `key`, so a plugin table's `key` column is redacted (#69).
