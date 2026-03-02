# @ezmode-games/drizzle-ledger

**Stop rewriting soft-delete for every project.**

Soft-delete, audit trail, and GDPR compliance for [Drizzle ORM](https://orm.drizzle.team/). SQLite, PostgreSQL, MySQL.

Born from [ezmode.games](https://ezmode.games) where we run this in production on Cloudflare D1. Extracted because we were tired of copying the same 500 lines between projects and watching them drift.

---

## The Problem

Every Drizzle project with user accounts ends up writing the same three things from scratch:

1. **Soft-delete** - `deleted_at` columns, filter helpers, remembering to exclude deleted records everywhere, praying nobody forgets the WHERE clause.

2. **Audit trail** - Who changed what, when, from where. Bolting on a log table, manually inserting after every mutation, copy-pasting the pattern across services.

3. **GDPR purge** - A user exercises their right to be forgotten. Anonymize their data in the audit trail without destroying the trail itself. Nobody thinks about this until a lawyer asks.

These three things are always the same code. They always interact with each other. And they always get reimplemented poorly because they're "not the product."

---

## Install

```bash
pnpm add @ezmode-games/drizzle-ledger
```

Peer dependency: `drizzle-orm >= 0.30.0`

---

## Why Soft-Delete

Hard deletes are a liability. Not philosophically - practically.

A user says they didn't authorize a charge. You need to look up their account. It's gone. A moderator bans someone for fraud and the support team needs context. Gone. A user rage-quits, deletes their account, comes back two days later asking to undo it. Gone.

Soft-delete means `DELETE FROM users WHERE id = ?` becomes `UPDATE users SET deleted_at = NOW(), deleted_by = ? WHERE id = ?`. The row stays. Your queries filter it out with `WHERE deleted_at IS NULL`. When someone needs the data for legal, fraud, support, or undo - it's there.

`deleted_by` tracks who performed the deletion. Was it the user themselves? An admin? A CRON job? That matters when you're debugging at 2am or responding to a legal request.

### What it provides

- **`softDeleteColumns`** - Spread `...softDeleteColumns` into any Drizzle table definition. Adds `deleted_at` (timestamp) and `deleted_by` (text). Dialect-specific: integer timestamp for SQLite, `timestamptz` for Postgres, `timestamp` for MySQL.
- **`softDeleteTimestamp`** - Same thing without `deleted_by` if you don't need to track who deleted it.
- **`notDeleted(table)`** - `WHERE deleted_at IS NULL`. Use this instead of remembering to add the filter manually.
- **`onlyDeleted(table)`** - `WHERE deleted_at IS NOT NULL`. For trash views, admin dashboards, recovery tools.
- **`softDeleteValues(userId?)`** - Returns `{ deletedAt: new Date(), deletedBy: userId ?? null }`. Pass to `.set()`.
- **`restoreValues()`** - Returns `{ deletedAt: null, deletedBy: null }`. Undo a soft-delete.
- **`isSoftDeleted(record)`** - Runtime check on a record object.

### What it does not provide

- Cascading soft-deletes. If you soft-delete a user, their posts don't automatically soft-delete. That's your business logic.
- Automatic query filtering. You have to call `notDeleted()` or use `createAuditedDb()`. There's no global middleware that silently hides rows - that will burn you when you're debugging why a record "doesn't exist" when it's sitting right there.
- Unique constraint handling. If you have a unique index on `email`, a soft-deleted row still occupies that slot. Handle this in your schema (partial indexes, or include `deleted_at` in the constraint).

```typescript
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { softDeleteColumns } from '@ezmode-games/drizzle-ledger/soft-delete/sqlite';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name'),
  email: text('email').unique(),
  ...softDeleteColumns,
});
```

Postgres: `@ezmode-games/drizzle-ledger/soft-delete/pg`. MySQL: `@ezmode-games/drizzle-ledger/soft-delete/mysql`.

---

## Why a Monkeypatch

`createAuditedDb(db)` intercepts `db.delete()` and rewrites it to a soft-delete UPDATE for any table that has a `deleted_at` column. Tables without it pass through to a normal hard delete.

Yes, this is a monkeypatch. No, this is not Ruby.

The reason is simple: the alternative is discipline. You tell your team "use `softDelete()` instead of `db.delete()`" and hope everyone remembers. In every file. In every service. In every code review. Forever. Somebody will write `db.delete(users).where(...)` at 11pm on a Friday and nobody will catch it until production data is gone.

The monkeypatch makes the wrong thing impossible. `db.delete()` does the right thing automatically. If a table has `deleted_at`, it soft-deletes. If it doesn't, it hard-deletes. You can still hard-delete explicitly via `hardDeleteTables` config. The escape hatch exists. It's just not the default.

The right thing happens by default. You can read the entire implementation in ~40 lines. It intercepts one method, checks one column, and rewrites to an UPDATE. That's it.

### What it provides

- **`createAuditedDb(db)`** - Wraps a Drizzle instance. `db.delete(table).where(...)` becomes `db.update(table).set(softDeleteValues()).where(...)` when the table has `deleted_at`.
- **`hardDeleteTables`** config - Opt specific tables out of soft-delete. Useful for session tables, logs, anything you actually want gone.
- **`softDeleteValuesFactory`** config - Custom soft-delete values if you need something beyond the default `{ deletedAt: new Date(), deletedBy: contextUserId }`.
- **Context-aware** - Automatically reads `deletedBy` from the AsyncLocalStorage ledger context if one is active.
- **Chainable** - `.where()`, `.returning()`, `.execute()` all work exactly like the original delete.

### What it does not provide

- Transaction wrapping. It doesn't start a transaction around the rewritten UPDATE.
- Audit logging. The monkeypatch only handles the delete-to-update rewrite. If you want audit entries logged too, use the `AuditLogger` or write them yourself.
- Undo. It soft-deletes the row. Restoring it is a separate operation (`restoreValues()`).

```typescript
import { createAuditedDb } from '@ezmode-games/drizzle-ledger/db';

const db = createAuditedDb(drizzle(env.DB), {
  hardDeleteTables: ['session', 'verification'], // these actually delete
});

// This becomes a soft-delete because users has deleted_at
await db.delete(users).where(eq(users.id, userId));

// This is a real delete because session is in hardDeleteTables
await db.delete(session).where(eq(session.id, sessionId));
```

---

## Audit Trail

Every mutation in your system should be traceable. Not because you love compliance documents, but because production breaks and you need to answer "what happened?" with data, not guesses.

The audit log records: **who** changed **what** record in **which** table, **when**, from **where** (IP, user agent, endpoint), and captures the **before** and **after** state as JSON snapshots.

### Context propagation

The audit context uses `AsyncLocalStorage`. Set it once in your middleware. Every audit entry created downstream - in any service, any helper, any nested function call - automatically inherits userId, IP, user agent, endpoint, and request ID. No prop drilling. No passing context objects through 6 function signatures.

```typescript
import { createLedgerContext, runWithLedgerContext } from '@ezmode-games/drizzle-ledger/context';

app.use(async (c, next) => {
  const context = createLedgerContext({
    userId: c.get('user')?.id,
    ip: c.req.header('x-forwarded-for'),
    userAgent: c.req.header('user-agent'),
    endpoint: `${c.req.method} ${c.req.path}`,
  });
  return runWithLedgerContext(context, next);
});
```

Works in Node.js, Bun, Deno, and Cloudflare Workers (AsyncLocalStorage is available in all of them). Lazy-initialized - no overhead if you never call it.

### Manual audit logging

For explicit control over what gets logged:

```typescript
import { logInsert, logUpdate, logSoftDelete, logDelete, logRestore } from '@ezmode-games/drizzle-ledger/audit';

// After inserting
const [user] = await db.insert(users).values(data).returning();
await logInsert(db, auditLog, 'users', user.id, user);

// After updating
const [oldUser] = await db.select().from(users).where(eq(users.id, id));
const [newUser] = await db.update(users).set(changes).where(eq(users.id, id)).returning();
await logUpdate(db, auditLog, 'users', id, oldUser, newUser);
```

### Automatic audit logging via Drizzle Logger

If you'd rather not call `logInsert` / `logUpdate` manually, the `AuditLogger` plugs into Drizzle's logger interface and intercepts SQL queries:

```typescript
import { AuditLogger } from '@ezmode-games/drizzle-ledger/logger';

const logger = new AuditLogger(
  async (entry) => {
    await db.insert(auditLog).values({ ...entry, id: uuidv7() });
  },
  { excludeTables: ['audit_log', 'session'] }
);

const db = drizzle(env.DB, { logger });
```

Parses INSERT/UPDATE/DELETE queries, extracts table name and record ID, captures context from AsyncLocalStorage, writes the entry. Fire-and-forget - errors are caught and logged to console, never thrown. Your mutations don't fail because audit logging broke.

### What it provides for SOC 2

SOC 2 Type II auditors want evidence that you track changes to sensitive data. This gives you:

- **CC6.1 (Logical access)** - Every entry records `userId`, tying mutations to authenticated users.
- **CC7.2 (System monitoring)** - Before/after snapshots of every change. `oldData` and `newData` as JSON.
- **CC8.1 (Change management)** - Timestamped, immutable audit entries with `action` type (INSERT, UPDATE, DELETE, SOFT_DELETE, RESTORE).
- **Source attribution** - IP address, user agent, API endpoint, request ID per entry.
- **Record history** - `getRecordHistory(db, auditLog, 'users', userId)` returns the full change history for any record, newest first.

### What it does not provide for SOC 2

- **Retention policies.** This doesn't auto-delete old audit entries. SOC 2 doesn't mandate a specific retention period, but your policy might. Write a CRON job.
- **Tamper protection.** Entries are regular database rows. Anyone with write access to the audit table can modify them. If you need tamper-evident logs, hash-chain the entries or ship them to an immutable store.
- **Access controls.** This doesn't restrict who can read or write audit entries. That's your database permissions.
- **Encryption at rest.** This stores oldData/newData as plaintext JSON. If those snapshots contain sensitive data, encrypt them before insertion or use database-level encryption.
- **Alerting.** No real-time monitoring, no anomaly detection, no Slack notifications. You get the data. What you do with it is up to you.

### What it provides for the real world

Beyond compliance theater:

- **"What happened to this user's account?"** - Pull the record history. See every change, who made it, when, from where.
- **"Who deleted this?"** - `deleted_by` field + audit entry with `SOFT_DELETE` action and the full before-state.
- **"Can we undo this?"** - `oldData` snapshot contains the pre-change state. You have the data to restore from.
- **"This user says they didn't do this"** - IP, user agent, endpoint, timestamp. Enough to determine if it was them or a compromised account.
- **Context that travels with the request** - Set it once in middleware, forget about it. Every audit entry from every service call in that request automatically gets the right userId and IP.

### What it does not provide for the real world

- **Diff computation.** It stores the full before and after state, not a delta. If you want "name changed from X to Y", compute it from oldData/newData yourself.
- **Schema evolution handling.** If you rename a column, old audit entries still have the old column name in their JSON snapshots. This doesn't migrate historical data.
- **Cross-service correlation.** The `requestId` field exists for this purpose, but you have to set it yourself. There's no distributed tracing built in.

---

## GDPR

### Accountability (Article 5(2))

GDPR requires you to demonstrate that personal data is processed lawfully and that you can account for what happens to it. The audit trail is that evidence. Every mutation to every table records who did it, when, from where (IP, user agent, endpoint), and captures the before and after state.

When a regulator asks "how do you demonstrate accountability for data processing?" - you point at the log.

#### What it provides

- **Actor attribution** - Every entry records `userId`. You know which authenticated user performed each operation.
- **Source attribution** - IP address, user agent, API endpoint, request ID. You know where the request came from.
- **Before/after snapshots** - `oldData` and `newData` as JSON. You can see exactly what changed.
- **Timestamped, typed actions** - INSERT, UPDATE, DELETE, SOFT_DELETE, RESTORE. You know what kind of operation was performed and when.

#### What it does not provide

- **Proof of lawful basis.** The log shows what happened, not why it was allowed. Tracking consent, legitimate interest, or contractual necessity is your responsibility.
- **Read access logging.** This logs mutations (writes). It does not log SELECT queries. If you need to prove who viewed personal data, you need separate access logging.

### Records of Processing (Article 30)

GDPR requires controllers to maintain records of processing activities. Every audit entry is a record of a processing activity - what table was affected, what action was taken, what data was involved, who performed it.

#### What it provides

- **Per-record history** - `getRecordHistory(db, auditLog, 'users', userId)` returns every processing activity for a specific record, newest first.
- **Table-level tracking** - `tableName` field on every entry. You can query all processing activities for a specific category of data.
- **Action categorization** - INSERT, UPDATE, DELETE, SOFT_DELETE, RESTORE. Each processing activity is typed.

#### What it does not provide

- **Processing purpose.** The log records that data was changed, not why. "Marketing," "service delivery," "fraud prevention" - you need to track purposes separately.
- **Data category classification.** The log doesn't know that `email` is contact data and `ip` is technical data. GDPR Article 30 requires you to describe categories of personal data. That's your documentation.
- **Third-party processor records.** If you share data with a payment processor or email provider, those transfers aren't captured here.

### Breach Response (Article 33)

When a breach happens, the first question is "what was affected?" You have 72 hours to notify the supervisory authority. The audit trail tells you which records were accessed or modified, by whom, and when. That's what you need to determine scope.

#### What it provides

- **Breach scope determination** - Query the audit log by time range, user, or table to determine what data was affected during an incident.
- **Timeline reconstruction** - Timestamped entries let you establish exactly when unauthorized changes occurred.
- **Actor identification** - `userId`, IP, user agent on every entry. If an account was compromised, you can see what it did.

#### What it does not provide

- **Breach detection.** This doesn't monitor for anomalies or alert you that a breach is happening. It gives you the data to investigate after you know.
- **Notification delivery.** It doesn't send emails to affected users or file reports with supervisory authorities. That's your process.
- **Risk assessment.** Determining whether a breach is "likely to result in a risk to the rights and freedoms of natural persons" is a human judgment call, not something a log can tell you.

### Right to Erasure (Article 17)

A user requests deletion of their personal data. You're legally required to comply. But you also have an audit trail full of their email, name, IP address, and user agent - data you might need for other legal obligations (fraud prevention, financial records, SOC 2).

GDPR says you can anonymize instead of delete. The audit trail structure stays intact. The PII goes away.

### What `purgeUserData` does

1. Finds all audit entries where `userId` matches the target user OR `recordId` matches (catches entries about the user made by admins).
2. Parses the `oldData` and `newData` JSON columns.
3. Recursively strips configured PII fields (email, name, phone, address, ip - anything you specify). Handles nested objects and arrays.
4. Replaces `userId` with `PURGED_USER` (or a custom string) - but only on entries the user themselves created. If an admin modified the user's record, the admin's userId stays.
5. Nullifies `ip` and `userAgent` on the user's own entries. Admin entries keep their metadata.
6. Writes the anonymized data back.

```typescript
import { purgeUserData, isUserDataPurged } from '@ezmode-games/drizzle-ledger/gdpr';

const result = await purgeUserData(db, auditLog, 'user-123', {
  piiFields: ['email', 'name', 'phone', 'address', 'ip', 'userAgent'],
  anonymizedUserId: 'PURGED_USER', // default
});
// { entriesAnonymized: 47, tablesProcessed: ['users', 'accounts'] }

// Idempotency check
const alreadyPurged = await isUserDataPurged(db, auditLog, 'user-123');
```

### What it provides

- **Selective anonymization** - You define which fields are PII. Different apps have different PII. A gaming platform's PII is different from a healthcare app's PII.
- **Admin preservation** - If `admin-456` modified `user-123`'s record, the admin's userId/IP/userAgent stays untouched. You're purging the user's data, not everyone who ever interacted with them.
- **Recursive stripping** - PII nested inside JSON objects and arrays gets found and removed.
- **Idempotent** - Safe to run multiple times. Already-purged entries don't break anything.
- **Malformed JSON tolerance** - If oldData/newData contains invalid JSON, it gets nullified instead of crashing the purge.

### What it does not provide

- **Data in other tables.** This only touches the audit log. If the user's email is in a `users` table, a `newsletter_subscribers` table, and an `orders` table, you need to handle those separately.
- **Data in other systems.** Payment processors, email providers, analytics services, CDN logs. GDPR covers all of it. This handles one table.
- **Data portability (Article 20).** This anonymizes data. It doesn't export it. If you need "give me all my data," build that separately.
- **DPO tooling.** No dashboards, no request tracking, no compliance workflows.

---

## Better Auth Integration

If you use [Better Auth](https://www.better-auth.com/), the plugin hooks into its `databaseHooks` to automatically log user/account create and update operations. The soft-delete callback intercepts `deleteUser` to perform soft-delete instead of hard delete.

```typescript
import { ledgerPlugin, createSoftDeleteCallback, isSoftDeletePerformed } from '@ezmode-games/drizzle-ledger/better-auth';

export const auth = betterAuth({
  user: {
    deleteUser: {
      enabled: true,
      beforeDelete: createSoftDeleteCallback({
        db,
        userTable: users,
        whereUserId: (userId) => eq(users.id, userId),
        writeAuditEntry: async (entry) => {
          await db.insert(auditLog).values({ ...entry, id: uuidv7() });
        },
      }),
    },
  },
  plugins: [
    ledgerPlugin({
      writeAuditEntry: async (entry) => {
        await db.insert(auditLog).values({ ...entry, id: uuidv7() });
      },
      auditTables: ['user', 'account'], // default. add 'session' if you want noise.
    }),
  ],
});
```

`createSoftDeleteCallback` performs the soft-delete UPDATE, logs an audit entry, then throws `SoftDeletePerformedError` to prevent Better Auth from executing the actual hard delete. In your client code:

```typescript
try {
  await auth.api.deleteUser({ userId });
} catch (error) {
  if (isSoftDeletePerformed(error)) {
    // Success. User was soft-deleted.
    return { success: true };
  }
  throw error; // Actual error
}
```

Yes, using a throw for flow control is ugly. Better Auth's `beforeDelete` hook doesn't have a "cancel the delete" return value. This is the cleanest way to prevent the hard delete from happening. The error has a `.code === 'SOFT_DELETE_PERFORMED'` and `.softDeleted === true` for reliable detection, even across serialization boundaries.

---

## Subpath Exports

Import only what you need. Every subpath is independently tree-shakeable.

| Import | What |
|--------|------|
| `@ezmode-games/drizzle-ledger` | Everything |
| `@ezmode-games/drizzle-ledger/soft-delete` | Dialect-agnostic helpers |
| `@ezmode-games/drizzle-ledger/soft-delete/sqlite` | SQLite columns |
| `@ezmode-games/drizzle-ledger/soft-delete/pg` | Postgres columns |
| `@ezmode-games/drizzle-ledger/soft-delete/mysql` | MySQL columns |
| `@ezmode-games/drizzle-ledger/schema/sqlite` | SQLite audit table |
| `@ezmode-games/drizzle-ledger/schema/pg` | Postgres audit table |
| `@ezmode-games/drizzle-ledger/schema/mysql` | MySQL audit table |
| `@ezmode-games/drizzle-ledger/audit` | Manual audit functions |
| `@ezmode-games/drizzle-ledger/context` | AsyncLocalStorage context |
| `@ezmode-games/drizzle-ledger/db` | Automatic soft-delete wrapper |
| `@ezmode-games/drizzle-ledger/gdpr` | GDPR purge |
| `@ezmode-games/drizzle-ledger/logger` | Drizzle Logger with audit |
| `@ezmode-games/drizzle-ledger/better-auth` | Better Auth plugin |

---

## License

MIT

---

Built by [ezmode.games](https://ezmode.games). Extracted from production because we kept copying the same files between projects and watching them drift apart.
