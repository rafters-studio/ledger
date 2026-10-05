---
"@rafters/ledger": minor
---

`ledgerPlugin` now audits hard deletes. Every table in `auditTables` gets a `databaseHooks.<table>.delete.after` hook that writes a `DELETE` entry with the deleted row, redacted, as `oldData`. That covers unlinking an account, revoking a session or signing out (with `session` listed), the sessions and accounts `deleteUser` removes, and the user row itself when `softDeleteUser` is off. Bulk deletes write one entry per row. A soft-deleted user still gets only `SOFT_DELETE`: the veto stops `delete.after` from firing (#45).

`createDeleteAuditCallback` is deprecated. With `user` in `auditTables`, the plugin already records a hard user delete, so using the callback too writes two `DELETE` entries for one delete. Remove it from `user.deleteUser.afterDelete`.
