/**
 * Ledger Redaction - Pure Helpers
 *
 * Strips secret material from audit payloads BEFORE they reach any
 * sink. Unlike the GDPR purge (opt-in, after the fact), redaction is
 * always on: an audit trail that stores tokens or password hashes is a
 * secrets store with a long retention policy.
 */

/**
 * Key patterns treated as secret material, matched case-insensitively
 * as SUBSTRINGS of the key name: "token" catches accessToken,
 * access_token, refreshToken, idToken; "secret" catches clientSecret;
 * "password" catches passwordHash.
 *
 * Substring matching over-redacts on purpose: "code" also catches
 * postalCode and countryCode, "hash" catches any *Hash field. Losing a
 * harmless field from an audit payload is the safe direction; storing
 * an OTP code in clear is not.
 *
 * Only key NAMES are inspected. A secret-shaped string (a JWT, a hex
 * token) under an innocent key passes through; list that key in
 * extraPatterns.
 */
export const DEFAULT_SECRET_PATTERNS: readonly string[] = [
  "token",
  "secret",
  "password",
  "apikey",
  "api_key",
  "otp",
  "code",
  "hash",
  "salt",
  "jwt",
  "credential",
  "privatekey",
  "private_key",
  "authorization",
  "cookie",
];

/**
 * Columns redacted by TABLE, not by key name, because the name alone
 * says nothing: better-auth's verification.value holds OTP codes and
 * reset tokens under the generic name "value". Matched against the
 * row's top-level keys only.
 */
export const TABLE_SECRET_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  verification: ["value"],
};

/** Replacement value for redacted fields. */
export const REDACTED_VALUE = "[REDACTED]";

/**
 * Replace secret-bearing fields in a JSON value with "[REDACTED]".
 * Recurses into nested objects and arrays; arrays stay arrays. A key
 * matches when any pattern appears case-insensitively anywhere in it,
 * and the entire value under a matching key is replaced regardless of
 * its shape.
 *
 * @param data - The JSON value to redact
 * @param extraPatterns - Additional key patterns beyond the defaults
 * @returns Redacted copy; the input is not mutated
 */
export function redactSensitiveFields(
  data: Record<string, unknown> | null,
  extraPatterns?: readonly string[],
): Record<string, unknown> | null;
export function redactSensitiveFields(data: unknown, extraPatterns?: readonly string[]): unknown;
export function redactSensitiveFields(data: unknown, extraPatterns?: readonly string[]): unknown {
  const patterns = [...DEFAULT_SECRET_PATTERNS, ...(extraPatterns ?? [])].map((p) =>
    p.toLowerCase(),
  );
  return redactValue(data, patterns);
}

function redactValue(value: unknown, loweredPatterns: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, loweredPatterns));
  }

  // Date instances pass through intact. Rebuilding them via
  // Object.entries would flatten them to {} (no own enumerable
  // properties) -- and better-auth rows carry live Date fields
  // (createdAt, accessTokenExpiresAt) on every audit write.
  if (value instanceof Date) {
    return value;
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const loweredKey = key.toLowerCase();
      const isSecret = loweredPatterns.some((pattern) => loweredKey.includes(pattern));
      // defineProperty, not assignment: a key literally named "__proto__"
      // survives JSON.parse as an own property, but plain assignment
      // would invoke the inherited setter and swap the prototype.
      Object.defineProperty(result, key, {
        value: isSecret ? REDACTED_VALUE : redactValue(entry, loweredPatterns),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return result;
  }

  return value;
}

/**
 * Redact a row of a named table: every key-name pattern via
 * redactSensitiveFields, then the table's TABLE_SECRET_COLUMNS
 * (top-level keys, exact name) on that fresh copy.
 *
 * @param tableName - The table the row belongs to
 * @param data - The row payload
 * @param extraPatterns - Additional key patterns beyond the defaults
 * @returns Redacted copy; the input is not mutated
 */
export function redactTableRow(
  tableName: string,
  data: Record<string, unknown> | null,
  extraPatterns?: readonly string[],
): Record<string, unknown> | null {
  const redacted = redactSensitiveFields(data, extraPatterns);
  const columns = Object.hasOwn(TABLE_SECRET_COLUMNS, tableName)
    ? TABLE_SECRET_COLUMNS[tableName]
    : undefined;
  if (redacted === null || columns === undefined) return redacted;
  for (const column of columns) {
    if (Object.hasOwn(redacted, column)) redacted[column] = REDACTED_VALUE;
  }
  return redacted;
}
