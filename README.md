# @rafters/ledger

Soft-delete, audit trail, and GDPR compliance for [Drizzle ORM](https://orm.drizzle.team/). SQLite, PostgreSQL, MySQL.

```bash
pnpm add @rafters/ledger
```

Peer dependency: `drizzle-orm >= 0.30.0`

Two entry points: `@rafters/ledger` for the ORM-agnostic core (context, pure helpers, always-on secret redaction, GDPR utilities), and `@rafters/ledger/drizzle` for the Drizzle adapter (schema, `createAuditedDb`, query filters, logging). Dialect-specific column definitions live at `@rafters/ledger/drizzle/soft-delete/sqlite`, `/pg`, and `/mysql`.

## Docs

Full documentation: [docs/](./docs/)

| Guide | Covers |
|---|---|
| [Getting Started](./docs/getting-started.mdx) | End-to-end setup walkthrough |
| [Soft-Delete](./docs/soft-delete.mdx) | Column helpers, query filters, automatic soft-delete, restore |
| [Audit Trail](./docs/audit-trail.mdx) | AuditLogger, manual logging, history queries |
| [Value-Free Audit Table](./docs/audit-table-sqlite.mdx) | Append-only SQLite/D1 audit SQL, no field values stored |
| [Context](./docs/context.mdx) | AsyncLocalStorage propagation, middleware setup |
| [GDPR](./docs/gdpr.mdx) | `purgeUserData`, PII anonymization, admin preservation |
| [Better Auth](./docs/better-auth.mdx) | `ledgerPlugin`, `createSoftDeleteCallback`, flow control |
| [API Reference](./docs/api-reference.mdx) | Every export, every type, organized by subpath |

## Soft-delete is not deletion until sessions die

`createSoftDeleteCallback` intercepts better-auth's `deleteUser` by throwing, which also aborts better-auth's own cleanup: nothing else revokes sessions, account/OAuth rows survive, and better-auth session resolution knows nothing about `deletedAt`. The callback therefore REQUIRES a `revokeSessions` implementation and runs it before anything else -- and you must additionally gate authentication on `deletedAt`, or an OAuth sign-in on the soft-deleted row silently resurrects the account. The full contract and a sign-in gate recipe live in the [Better Auth guide](./docs/better-auth.mdx) and on the `createSoftDeleteCallback` docblock.

## License

MIT. Authored by Sean Silvius. Source: [github.com/rafters-studio/ledger](https://github.com/rafters-studio/ledger).
