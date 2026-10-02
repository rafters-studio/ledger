-- @rafters/ledger: append-only, value-free audit table for SQLite and Cloudflare D1.
--
-- Records who changed which row, when, and which columns. It stores no field
-- values, so there is nothing to purge for GDPR and the table never needs an
-- UPDATE or DELETE. The triggers below abort both, with no bypass.
--
-- Copy this file into your migrations folder, for example:
--   wrangler d1 migrations create <db> add-ledger-audit
--   (paste this file's contents into the generated migration)

CREATE TABLE IF NOT EXISTS ledger_audit (
  id TEXT PRIMARY KEY NOT NULL,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'SOFT_DELETE', 'DELETE')),
  changed_fields TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changed_fields) AND json_type(changed_fields) = 'array'),
  user_id TEXT,
  ip TEXT,
  user_agent TEXT,
  endpoint TEXT,
  request_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_ledger_audit_table_record ON ledger_audit (table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_ledger_audit_user ON ledger_audit (user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_audit_created ON ledger_audit (created_at);

CREATE TRIGGER IF NOT EXISTS trg_ledger_audit_no_update
BEFORE UPDATE ON ledger_audit
BEGIN
  SELECT RAISE(ABORT, 'ledger_audit is append-only: UPDATE is not allowed');
END;

CREATE TRIGGER IF NOT EXISTS trg_ledger_audit_no_delete
BEFORE DELETE ON ledger_audit
BEGIN
  SELECT RAISE(ABORT, 'ledger_audit is append-only: DELETE is not allowed');
END;

-- INSERT OR REPLACE deletes a conflicting row without firing DELETE triggers
-- (SQLite runs them only when recursive_triggers is on), so refuse any insert
-- that would replace an existing entry.
CREATE TRIGGER IF NOT EXISTS trg_ledger_audit_no_replace
BEFORE INSERT ON ledger_audit
WHEN EXISTS (SELECT 1 FROM ledger_audit WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'ledger_audit is append-only: REPLACE is not allowed');
END;
