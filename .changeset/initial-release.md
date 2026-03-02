---
"@ezmode-games/drizzle-ledger": minor
---

Initial release. Soft-delete, audit trail, and GDPR compliance for Drizzle ORM.

- Multi-dialect soft-delete columns (SQLite, PostgreSQL, MySQL)
- Automatic delete-to-soft-delete via `createAuditedDb`
- AsyncLocalStorage audit context propagation
- Audit logging via Drizzle Logger interface
- GDPR Article 17 audit log anonymization
- Better Auth plugin integration
- Pre-built audit log schema for all three dialects
