/**
 * Ledger GDPR - Pure Helpers
 *
 * ORM-agnostic GDPR compliance utilities.
 */

/**
 * Configuration for GDPR purge operation.
 */
export interface PurgeConfig {
  /** Fields to remove from JSON data columns (defaults to common PII fields) */
  piiFields?: string[];
  /** Replacement value for userId (default: 'PURGED_USER') */
  anonymizedUserId?: string;
}

/**
 * Result of a GDPR purge operation.
 */
export interface PurgeResult {
  /** Number of audit entries anonymized */
  entriesAnonymized: number;
  /** Tables that had audit entries anonymized */
  tablesProcessed: string[];
}

/** Default PII fields to remove from JSON data */
export const DEFAULT_PII_FIELDS = [
  "email",
  "name",
  "firstName",
  "lastName",
  "phone",
  "address",
  "ip",
  "ipAddress",
  "userAgent",
];

/**
 * Remove PII fields from a JSON object.
 * Recursively processes nested objects.
 *
 * @param data - The data to anonymize (can be null)
 * @param piiFields - Fields to remove
 * @returns Anonymized data with PII fields removed
 *
 * @example
 * ```typescript
 * const data = { id: '123', email: 'test@test.com', name: 'John', role: 'admin' };
 * const result = anonymizeJsonData(data, ['email', 'name']);
 * // { id: '123', role: 'admin' }
 * ```
 */
export function anonymizeJsonData(
  data: Record<string, unknown> | null,
  piiFields: string[],
): Record<string, unknown> | null {
  if (data === null) {
    return null;
  }

  const result: Record<string, unknown> = {};
  const piiFieldsSet = new Set(piiFields);

  for (const [key, value] of Object.entries(data)) {
    // Skip PII fields
    if (piiFieldsSet.has(key)) {
      continue;
    }

    // Recursively process nested objects
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = anonymizeJsonData(value as Record<string, unknown>, piiFields);
    } else if (Array.isArray(value)) {
      // Process arrays - anonymize objects within arrays
      result[key] = value.map((item) => {
        if (item !== null && typeof item === "object") {
          return anonymizeJsonData(item as Record<string, unknown>, piiFields);
        }
        return item;
      });
    } else {
      result[key] = value;
    }
  }

  return result;
}
