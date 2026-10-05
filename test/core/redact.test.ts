import { describe, expect, test } from "vitest";
import {
  DEFAULT_SECRET_PATTERNS,
  REDACTED_VALUE,
  redactSensitiveFields,
  redactTableRow,
  TABLE_SECRET_COLUMNS,
} from "../../src/core/redact.js";

describe("redactSensitiveFields", () => {
  test("redacts default secret patterns as case-insensitive substrings", () => {
    const data = {
      accessToken: "gho_abc",
      refresh_token: "ghr_def",
      IdToken: "eyJ",
      clientSecret: "shh",
      passwordHash: "argon2",
      ApiKey: "sk-1",
      api_key: "sk-2",
      keep: "visible",
    };

    const result = redactSensitiveFields(data) as Record<string, unknown>;

    expect(result.accessToken).toBe(REDACTED_VALUE);
    expect(result.refresh_token).toBe(REDACTED_VALUE);
    expect(result.IdToken).toBe(REDACTED_VALUE);
    expect(result.clientSecret).toBe(REDACTED_VALUE);
    expect(result.passwordHash).toBe(REDACTED_VALUE);
    expect(result.ApiKey).toBe(REDACTED_VALUE);
    expect(result.api_key).toBe(REDACTED_VALUE);
    expect(result.keep).toBe("visible");
  });

  test("replaces the entire value under a matching key, object or not", () => {
    const data = { tokens: { access: "a", refresh: "b" } };
    const result = redactSensitiveFields(data) as Record<string, unknown>;

    expect(result.tokens).toBe(REDACTED_VALUE);
  });

  test("recurses into nested objects and arrays; arrays stay arrays", () => {
    const data = {
      accounts: [{ accessToken: "t1", provider: "github" }, { provider: "google" }],
      nested: { deep: { password: "p" } },
    };
    const result = redactSensitiveFields(data) as {
      accounts: { accessToken?: string; provider: string }[];
      nested: { deep: { password: string } };
    };

    expect(Array.isArray(result.accounts)).toBe(true);
    expect(result.accounts[0].accessToken).toBe(REDACTED_VALUE);
    expect(result.accounts[0].provider).toBe("github");
    expect(result.nested.deep.password).toBe(REDACTED_VALUE);
  });

  test("supports extra patterns", () => {
    const data = { ssn: "123-45-6789", name: "keep" };
    const result = redactSensitiveFields(data, ["ssn"]) as Record<string, unknown>;

    expect(result.ssn).toBe(REDACTED_VALUE);
    expect(result.name).toBe("keep");
  });

  test("does not mutate the input", () => {
    const data = { accessToken: "gho_abc" };
    redactSensitiveFields(data);

    expect(data.accessToken).toBe("gho_abc");
  });

  test("Date instances round-trip intact, not flattened to {}", () => {
    const createdAt = new Date("2026-08-02T12:00:00Z");
    const data = { id: "u1", createdAt, accessToken: "gho_x" };
    const result = redactSensitiveFields(data) as Record<string, unknown>;

    expect(result.createdAt).toBe(createdAt);
    expect(result.createdAt).toBeInstanceOf(Date);
    // Serialization keeps the ISO string, not "{}"
    expect(JSON.stringify(result)).toContain("2026-08-02T12:00:00.000Z");
  });

  test("null and primitives pass through", () => {
    expect(redactSensitiveFields(null)).toBeNull();
    expect(redactSensitiveFields("plain")).toBe("plain");
    expect(redactSensitiveFields(42)).toBe(42);
  });

  test("a literal __proto__ key cannot swap the prototype", () => {
    const parsed = JSON.parse('{"__proto__":{"isAdmin":true},"id":"1"}') as Record<string, unknown>;
    const result = redactSensitiveFields(parsed) as Record<string, unknown>;

    expect(JSON.stringify(result)).toBe('{"__proto__":{"isAdmin":true},"id":"1"}');
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect((result as { isAdmin?: unknown }).isAdmin).toBeUndefined();
  });

  test.each([
    ["otp", "otpCode"],
    ["otp", "OTP"],
    ["code", "code"],
    ["code", "resetCode"],
    ["hash", "hash"],
    ["hash", "backupHash"],
    ["salt", "salt"],
    ["salt", "passwordSalt"],
    ["jwt", "jwt"],
    ["jwt", "sessionJWT"],
    ["credential", "credential"],
    ["credential", "credentialId"],
    ["privatekey", "privateKey"],
    ["private_key", "private_key"],
    ["authorization", "Authorization"],
    ["cookie", "cookie"],
    ["cookie", "setCookie"],
  ])("default pattern %s redacts key %s", (_pattern, key) => {
    const result = redactSensitiveFields({ [key]: "s3cr3t", keep: "visible" }) as Record<
      string,
      unknown
    >;

    expect(result[key]).toBe(REDACTED_VALUE);
    expect(result.keep).toBe("visible");
  });

  test("code matches as a substring, over-redacting postalCode and countryCode", () => {
    const result = redactSensitiveFields({ postalCode: "94110", countryCode: "US" }) as Record<
      string,
      unknown
    >;

    expect(result.postalCode).toBe(REDACTED_VALUE);
    expect(result.countryCode).toBe(REDACTED_VALUE);
  });

  test("string values are not inspected: a secret under an innocent key passes", () => {
    const result = redactSensitiveFields({ note: "eyJhbGciOiJIUzI1NiJ9.e30.sig" }) as Record<
      string,
      unknown
    >;

    expect(result.note).toBe("eyJhbGciOiJIUzI1NiJ9.e30.sig");
  });

  test("default pattern list is the documented set", () => {
    expect(DEFAULT_SECRET_PATTERNS).toEqual([
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
    ]);
  });
});

describe("redactTableRow", () => {
  test("redacts the verification value column by table rule", () => {
    const row = {
      id: "v1",
      identifier: "email-verification:a@b.co",
      value: "482913",
      expiresAt: "2026-10-05T12:00:00Z",
    };
    const result = redactTableRow("verification", row);

    expect(result?.value).toBe(REDACTED_VALUE);
    expect(result?.identifier).toBe("email-verification:a@b.co");
    expect(result?.id).toBe("v1");
    expect(row.value).toBe("482913");
  });

  test("value is not redacted on tables without a column rule", () => {
    const result = redactTableRow("user", { id: "u1", value: "visible" });

    expect(result?.value).toBe("visible");
  });

  test("key-name patterns still apply alongside the table rule", () => {
    const result = redactTableRow("verification", { value: "482913", resetToken: "t" }, ["ssn"]);

    expect(result?.value).toBe(REDACTED_VALUE);
    expect(result?.resetToken).toBe(REDACTED_VALUE);
  });

  test("a value column that is absent is not added", () => {
    const result = redactTableRow("verification", { id: "v1" });

    expect(result).toEqual({ id: "v1" });
  });

  test("null passes through and inherited table names do not match", () => {
    expect(redactTableRow("verification", null)).toBeNull();
    expect(redactTableRow("toString", { value: "visible" })?.value).toBe("visible");
  });

  test("the table rule set is verification.value", () => {
    expect(TABLE_SECRET_COLUMNS).toEqual({ verification: ["value"] });
  });
});
