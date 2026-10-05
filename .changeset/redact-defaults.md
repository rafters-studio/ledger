---
"@rafters/ledger": minor
---

Redaction defaults now also match `otp`, `code`, `hash`, `salt`, `jwt`, `credential`, `privatekey`, `private_key`, `authorization`, and `cookie` (substring match, so `postalCode` and `countryCode` are redacted too). New `TABLE_SECRET_COLUMNS` and `redactTableRow` redact better-auth's `verification.value` column (OTP codes, reset tokens) by table, applied on every plugin audit path.
