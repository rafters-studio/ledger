# @rafters/ledger

## 0.4.1

### Patch Changes

- 0.4.0 never reached npm: the release workflow's old setup (Node 20 actions and a `registry-url` placeholder token alongside trusted publishing) reported success without publishing. 0.4.1 carries every 0.4.0 change listed below, published from the updated workflow. Upgrade from 0.3.0 straight to 0.4.1 and follow the 0.4.0 migration notes.

## 0.4.0

### Minor Changes

- dc29e55: Breaking: the better-auth peer range is now `>=1.7.0 <2.0.0` (was `>=1.5.0 <1.7.0`), and user soft delete is rebuilt on better-auth 1.7's `databaseHooks.user.delete.before`. `ledgerPlugin({ softDeleteUser: true })` sets `deletedAt` (and `deletedBy` when the user schema declares it) through better-auth's own adapter, writes a redacted `SOFT_DELETE` entry, and returns `false` so better-auth skips the row delete. Nothing throws: the `deleteUser` route revokes sessions, clears the cookie, and answers success, so self-service delete over HTTP no longer returns 500 (#44). It takes no ORM handle and works with any better-auth adapter.

  Retired exports: `createSoftDeleteCallback`, `SoftDeleteCallbackOptions` (with `revokeSessions`), `SoftDeletePerformedError`, and `isSoftDeletePerformed` (from `@rafters/ledger/better-auth`, `@rafters/ledger`, and the core errors), and the `softDeleteTables` option of `ledgerPlugin`, which only logged a `SOFT_DELETE` entry.

  better-auth deletes the user's session and account rows before the user hook runs, so a soft-deleted user's credentials and OAuth links are gone; the user row survives. Keep the sign-in gate on `deletedAt` from the better-auth guide.

  Migration: upgrade better-auth to 1.7. Remove `beforeDelete: createSoftDeleteCallback(...)` and any `isSoftDeletePerformed` catch around `deleteUser`. Declare `deletedAt` (and optionally `deletedBy`) in `user.additionalFields` with `input: false`, and pass `softDeleteUser: true` to `ledgerPlugin` (replacing `softDeleteTables: ["user"]`). The plugin throws at init if `deletedAt` is not declared.

- 069671f: `ledgerPlugin` now audits hard deletes. Every table in `auditTables` gets a `databaseHooks.<table>.delete.after` hook that writes a `DELETE` entry with the deleted row, redacted, as `oldData`. That covers unlinking an account, revoking a session or signing out (with `session` listed), the sessions and accounts `deleteUser` removes, and the user row itself when `softDeleteUser` is off. Bulk deletes write one entry per row. A soft-deleted user still gets only `SOFT_DELETE`: the veto stops `delete.after` from firing (#45).

  `createDeleteAuditCallback` is deprecated. With `user` in `auditTables`, the plugin already records a hard user delete, so using the callback too writes two `DELETE` entries for one delete. Remove it from `user.deleteUser.afterDelete`.

- 16605f3: `ledgerPlugin` attributes audit entries from the hook context better-auth passes every `databaseHook`. The actor is the endpoint's session user first, then the ledger context's `userId`, then the target row's own id for user sign-up and user deletion. An admin updating a user is attributed to the admin with no `runWithLedgerContext` middleware, even when ledger's own context storage is unavailable. `update.before`/`update.after` change sets pair on the hook context, so `oldData: { changed }` is captured without ledger context too. `runWithLedgerContext` still attributes writes outside an endpoint and carries `ip`, `userAgent`, `endpoint`, and `requestId` (#46).
- 16f996d: Add `@rafters/ledger/kysely`, a Kysely plugin for SQLite and D1. A table soft-deletes if and only if it has a `deleted_at` column; every insert, update, and delete writes value-free audit entries with the real primary key. Raw `DELETE` on a soft-delete table throws. The ledger context now lives on `globalThis`, so a context set through one package entry point is visible through the others.
- 2f68944: Redaction defaults now also match `otp`, `code`, `hash`, `salt`, `jwt`, `credential`, `privatekey`, `private_key`, `authorization`, and `cookie` (substring match, so `postalCode` and `countryCode` are redacted too). New `TABLE_SECRET_COLUMNS` and `redactTableRow` redact better-auth's `verification.value` column (OTP codes, reset tokens) by table, applied on every plugin audit path.
- 6857312: Breaking: `createAuditedDb` now requires `softDeleteTables`. The mode that guessed soft-delete tables from a `deletedAt` column is gone, because a table it missed hard-deleted silently. A call without the allowlist fails type-check, and an untyped caller that omits it gets `MissingSoftDeleteTablesError` (exported from `@rafters/ledger/drizzle`) at the first delete.

  Migration: add `softDeleteTables` to every `createAuditedDb` call, listing each table that has `deletedAt` and should soft-delete, for example `createAuditedDb(db, { softDeleteTables: ["users", "messages"] })`. Pass `[]` to soft-delete nothing. Unlisted tables hard-delete; a listed table without `deletedAt` throws `MissingSoftDeleteColumnError`.

- de03a63: `createAuditedDb` soft-delete audit entries now carry the affected row's primary key as `recordId`, one entry per row, instead of one statement-level entry with `recordId: "unknown"`, so `purgeUserData` can reach them. A delete that matches no rows writes no entry.

  Behavior change when `writeAuditEntry` is configured: on SQLite and PostgreSQL the soft-delete UPDATE runs with `RETURNING` the primary key, so `await db.delete(t).where(...)` without its own `.returning()` resolves to the affected keys (for example `[{ id: "u1" }]`) instead of the driver's run result. A caller's own `.returning()` rows are unchanged. On MySQL the keys are selected before the UPDATE (not atomic). `.run()` executes through `.all()` and resolves to the rows instead of the driver's run result; `.values()` records the keys from its row arrays. Neither writes an entry when nothing matched. A listed table with no primary key throws `MissingPrimaryKeyError` (exported from `@rafters/ledger/drizzle`).

- c9fc1b6: Add an append-only, value-free audit table for SQLite and D1 (`sql/sqlite/audit.sql`, exported as `@rafters/ledger/sql/sqlite/audit.sql`) and the `ValueFreeAuditEntry` type. Field names only, no values; triggers abort every UPDATE, DELETE, and replacing INSERT.

### Patch Changes

- de59183: `softDeleteUser` writes `deletedBy` from the resolved actor (the hook context's session user, else the ledger context's `userId`) instead of always `null`, so an admin's `removeUser` records the admin. `deletedBy` stays `null` only when no context names an actor; the `SOFT_DELETE` entry still falls back to the deleted user's id for `userId`. The deprecated `createDeleteAuditCallback` attributes its `DELETE` entry to the ledger context's `userId` before falling back to the deleted user (#43).
- f1b156e: Raise `engines.node` to `>=22.5`, the first Node with `node:sqlite`, which the better-auth integration suite runs on.

## 0.3.0

### Minor Changes

- f3d55de: AuditLogger no longer fire-and-forgets writes (waitUntil/flush), surfaces unparseable mutations as visible "unknown" entries, excludes bound params from entries unless includeParams is set, restricts extractRecordId to UUID-shaped params, and compares table filters case-insensitively. Behavior change: params are no longer populated by default and non-UUID record ids are no longer extracted.
- bd40d2a: createAuditedDb no longer mutates the input db (returns a Proxy), converts deletes inside transactions, executes soft-delete-all for unfiltered deletes instead of silently no-opping, adds an allowlist mode (softDeleteTables) that throws on misconfigured or unresolvable tables, and emits statement-level SOFT_DELETE audit entries -- including for batch-executed statements -- when a writeAuditEntry sink is configured.
- 3dc2fb0: purgeUserData gains ownership-aware matching (ownedRecords config) so entries written by admins/system about a user's records are reachable; executes via db.batch (all-or-nothing on D1/libsql); appends a PURGE audit entry per run; and reports unparseable-JSON rows via entriesSkipped instead of silently preserving them. anonymizeJsonData is hardened against literal `__proto__` keys. PURGE joins the action enum (type-level only; no DB migration).
- d75c864: Hardening: assertLedgerContextAvailable() boot check plus a one-time warning when AsyncLocalStorage is missing (unattributed audit trails no longer degrade silently); AUDIT_LOG_PROTECT_SQL per dialect for engine-level append-only audit tables; createAuditedDb refuses deletes on the audit table (AuditTableDeleteError); isSoftDeletePerformed documents its in-process trust boundary; context docs use the platform's trusted client-ip source.
- c116f3d: BREAKING: ledgerPlugin's default auditTables drops from ["user", "account"] to ["user"] -- better-auth account rows carry OAuth tokens and password hashes; auditing account is now opt-in. New always-on, fail-closed secret redaction (redactSensitiveFields, DEFAULT_SECRET_PATTERNS) applied to every better-auth audit path; Date values pass through intact.
- 2e92734: BREAKING: createSoftDeleteCallback now requires a revokeSessions callback and runs it before the soft-delete UPDATE. Revocation failure aborts the deletion with the real error. Wire it to better-auth's internal adapter -- `deleteUserSessions(userId)` on current 1.6.x, feature-detected per the docs (`deleteSessions(userId)` silently deletes nothing after better-auth's mid-1.6 API split) -- and gate sign-in on deletedAt; the docs carry both recipes.

### Patch Changes

- aa14fe9: Fix dev-workflow leak: `lefthook install` moved from `postinstall` to `prepare`. Consumers installing `@rafters/ledger` from the registry no longer execute `lefthook install` at install time. `prepare` still runs for contributors doing a local `pnpm install` in the source repo, so git hooks remain wired up.
- f9e9806: ledgerPlugin audit entries attribute to the acting principal from ledger context (never the target row's id), and update entries carry the incoming change set as oldData { changed }, paired per-request via the LedgerContext object so concurrent requests cannot cross-pair and failed updates cannot desync the plugin. Change-set capture, like attribution, requires runWithLedgerContext.
- 8b9eae8: better-auth 1.6 support verified against installed 1.6.25 source: hook veto/merge semantics and same-chain after-hook draining hold, so the attribution pairing and revocation ordering contracts are intact. A real peerDependencies range is declared (>=1.5.0 <1.7.0). Session-revocation wiring docs updated for better-auth's mid-1.6 internal API split: deleteSessions(userId) silently deletes nothing on late 1.6.x -- use deleteUserSessions(userId), feature-detected in the examples.
