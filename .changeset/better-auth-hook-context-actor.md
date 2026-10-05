---
"@rafters/ledger": minor
---

`ledgerPlugin` attributes audit entries from the hook context better-auth passes every `databaseHook`. The actor is the endpoint's session user first, then the ledger context's `userId`, then the target row's own id for user sign-up and user deletion. An admin updating a user is attributed to the admin with no `runWithLedgerContext` middleware, even when ledger's own context storage is unavailable. `update.before`/`update.after` change sets pair on the hook context, so `oldData: { changed }` is captured without ledger context too. `runWithLedgerContext` still attributes writes outside an endpoint and carries `ip`, `userAgent`, `endpoint`, and `requestId` (#46).
