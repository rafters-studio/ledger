---
"@rafters/ledger": minor
---

`createAuditedDb` soft-delete audit entries now carry the affected row's primary key as `recordId`, one entry per row, instead of one statement-level entry with `recordId: "unknown"`, so `purgeUserData` can reach them. A delete that matches no rows writes no entry.

Behavior change when `writeAuditEntry` is configured: on SQLite and PostgreSQL the soft-delete UPDATE runs with `RETURNING` the primary key, so `await db.delete(t).where(...)` without its own `.returning()` resolves to the affected keys (for example `[{ id: "u1" }]`) instead of the driver's run result. A caller's own `.returning()` rows are unchanged. On MySQL the keys are selected before the UPDATE (not atomic). `.run()` and `.values()` still write one statement-level `"unknown"` entry. A listed table with no primary key throws `MissingPrimaryKeyError` (exported from `@rafters/ledger/drizzle`).
