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
| [Kysely](./docs/kysely.mdx) | Soft-delete and audit plugin for SQLite and D1 |
| [Context](./docs/context.mdx) | AsyncLocalStorage propagation, middleware setup |
| [GDPR](./docs/gdpr.mdx) | `purgeUserData`, PII anonymization, admin preservation |
| [Better Auth](./docs/better-auth.mdx) | `ledgerPlugin`, user soft delete on better-auth 1.7+ |
| [API Reference](./docs/api-reference.mdx) | Every export, every type, organized by subpath |

## better-auth soft delete keeps the row, not the credentials

`ledgerPlugin({ softDeleteUser: true })` soft-deletes better-auth users through `databaseHooks.user.delete.before` (better-auth 1.7+): it sets `deletedAt`, writes a `SOFT_DELETE` entry, and vetoes the row delete, while better-auth still revokes sessions and answers success. better-auth deletes the user's account rows (password hashes, OAuth links) before that hook runs, and its session resolution knows nothing about `deletedAt`, so you must gate sign-in on `deletedAt` or an OAuth sign-in with account linking brings the user back. The recipe lives in the [Better Auth guide](./docs/better-auth.mdx).

## License

MIT. Authored by Sean Silvius. Source: [github.com/rafters-studio/ledger](https://github.com/rafters-studio/ledger).
