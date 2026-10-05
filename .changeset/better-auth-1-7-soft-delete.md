---
"@rafters/ledger": minor
---

Breaking: the better-auth peer range is now `>=1.7.0 <2.0.0` (was `>=1.5.0 <1.7.0`), and user soft delete is rebuilt on better-auth 1.7's `databaseHooks.user.delete.before`. `ledgerPlugin({ softDeleteUser: true })` sets `deletedAt` (and `deletedBy` when the user schema declares it) through better-auth's own adapter, writes a redacted `SOFT_DELETE` entry, and returns `false` so better-auth skips the row delete. Nothing throws: the `deleteUser` route revokes sessions, clears the cookie, and answers success, so self-service delete over HTTP no longer returns 500 (#44). It takes no ORM handle and works with any better-auth adapter.

Retired exports: `createSoftDeleteCallback`, `SoftDeleteCallbackOptions` (with `revokeSessions`), `SoftDeletePerformedError`, and `isSoftDeletePerformed` (from `@rafters/ledger/better-auth`, `@rafters/ledger`, and the core errors), and the `softDeleteTables` option of `ledgerPlugin`, which only logged a `SOFT_DELETE` entry.

better-auth deletes the user's session and account rows before the user hook runs, so a soft-deleted user's credentials and OAuth links are gone; the user row survives. Keep the sign-in gate on `deletedAt` from the better-auth guide.

Migration: upgrade better-auth to 1.7. Remove `beforeDelete: createSoftDeleteCallback(...)` and any `isSoftDeletePerformed` catch around `deleteUser`. Declare `deletedAt` (and optionally `deletedBy`) in `user.additionalFields` with `input: false`, and pass `softDeleteUser: true` to `ledgerPlugin` (replacing `softDeleteTables: ["user"]`). The plugin throws at init if `deletedAt` is not declared.
