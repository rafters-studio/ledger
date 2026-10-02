---
"@rafters/ledger": minor
---

Add an append-only, value-free audit table for SQLite and D1 (`sql/sqlite/audit.sql`, exported as `@rafters/ledger/sql/sqlite/audit.sql`) and the `ValueFreeAuditEntry` type. Field names only, no values; triggers abort every UPDATE, DELETE, and replacing INSERT.
