# @rafters/ledger

Soft-delete, audit trail, and GDPR compliance for [Drizzle ORM](https://orm.drizzle.team/). SQLite, PostgreSQL, MySQL.

```bash
pnpm add @rafters/ledger
```

Peer dependency: `drizzle-orm >= 0.30.0`

## Docs

Full documentation: [docs/](./docs/)

| Guide | Covers |
|---|---|
| [Getting Started](./docs/getting-started.mdx) | End-to-end setup walkthrough |
| [Soft-Delete](./docs/soft-delete.mdx) | Column helpers, query filters, automatic soft-delete, restore |
| [Audit Trail](./docs/audit-trail.mdx) | AuditLogger, manual logging, history queries |
| [Context](./docs/context.mdx) | AsyncLocalStorage propagation, middleware setup |
| [GDPR](./docs/gdpr.mdx) | `purgeUserData`, PII anonymization, admin preservation |
| [Better Auth](./docs/better-auth.mdx) | `ledgerPlugin`, `createSoftDeleteCallback`, flow control |
| [API Reference](./docs/api-reference.mdx) | Every export, every type, organized by subpath |

## License

MIT. Authored by Sean Silvius. Source: [github.com/rafters-studio/ledger](https://github.com/rafters-studio/ledger).
