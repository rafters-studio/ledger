---
"@rafters/ledger": minor
---

Initial release. ORM-agnostic audit trail, soft-delete, and GDPR compliance.

Core (`@rafters/ledger`):
- AsyncLocalStorage context propagation
- Pure soft-delete value helpers
- Audit entry creation
- GDPR PII anonymization
- SoftDeletePerformedError for flow control

Drizzle adapter (`@rafters/ledger/drizzle`):
- Multi-dialect soft-delete columns (SQLite, PostgreSQL, MySQL)
- Automatic delete-to-soft-delete via `createAuditedDb`
- Audit logging via Drizzle Logger interface
- Audit query functions with full change history
- GDPR Article 17 audit log purge
- Pre-built audit log schema for all three dialects

Better Auth (`@rafters/ledger/better-auth`):
- Audit plugin for user/account mutations
- Soft-delete callback for user deletion
