---
"@rafters/ledger": patch
---

`softDeleteUser` writes `deletedBy` from the resolved actor (the hook context's session user, else the ledger context's `userId`) instead of always `null`, so an admin's `removeUser` records the admin. `deletedBy` stays `null` only when no context names an actor; the `SOFT_DELETE` entry still falls back to the deleted user's id for `userId`. The deprecated `createDeleteAuditCallback` attributes its `DELETE` entry to the ledger context's `userId` before falling back to the deleted user (#43).
