---
"@rafters/ledger": minor
---

Add `@rafters/ledger/kysely`, a Kysely plugin for SQLite and D1. A table soft-deletes if and only if it has a `deleted_at` column; every insert, update, and delete writes value-free audit entries with the real primary key. Raw `DELETE` on a soft-delete table throws. The ledger context now lives on `globalThis`, so a context set through one package entry point is visible through the others.
