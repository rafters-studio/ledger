---
"@rafters/ledger": minor
---

Breaking: `createAuditedDb` now requires `softDeleteTables`. The mode that guessed soft-delete tables from a `deletedAt` column is gone, because a table it missed hard-deleted silently. A call without the allowlist fails type-check, and an untyped caller that omits it gets `MissingSoftDeleteTablesError` (exported from `@rafters/ledger/drizzle`) at the first delete.

Migration: add `softDeleteTables` to every `createAuditedDb` call, listing each table that has `deletedAt` and should soft-delete, for example `createAuditedDb(db, { softDeleteTables: ["users", "messages"] })`. Pass `[]` to soft-delete nothing. Unlisted tables hard-delete; a listed table without `deletedAt` throws `MissingSoftDeleteColumnError`.
