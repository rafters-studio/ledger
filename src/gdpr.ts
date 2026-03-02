/**
 * Drizzle Ledger GDPR Purge
 *
 * GDPR-compliant user data purge that anonymizes audit logs
 * without deleting the audit trail.
 *
 * @example
 * ```typescript
 * import { purgeUserData } from 'drizzle-ledger/gdpr';
 *
 * // Anonymize all user data in audit logs
 * const result = await purgeUserData(db, auditLog, 'user-123', {
 *   piiFields: ['email', 'name', 'ip', 'address', 'phone'],
 * });
 *
 * console.log(`Anonymized ${result.entriesAnonymized} audit entries`);
 * ```
 */

import { eq, or } from "drizzle-orm";
import type { AuditLog } from "./schema/sqlite.js";

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
const DEFAULT_PII_FIELDS = [
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

/** Default replacement value for userId */
const DEFAULT_ANONYMIZED_USER_ID = "PURGED_USER";

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

/**
 * Safely parse JSON string, returning null on error.
 */
function safeJsonParse(json: string | null): Record<string, unknown> | null {
  if (json === null) {
    return null;
  }
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    // Return null for malformed JSON
    return null;
  }
}

// Type for Drizzle database with update capability
// biome-ignore lint/suspicious/noExplicitAny: Required for Drizzle db type compatibility
type DrizzleDb = { update: (table: any) => any; select: () => any };

/**
 * Anonymize all user data in audit logs.
 * Does NOT delete records - preserves audit trail with PII removed.
 *
 * This function:
 * 1. Finds all audit entries for the user (by userId OR recordId)
 * 2. Replaces userId with anonymized value (only for entries created by the user)
 * 3. Nullifies ip and userAgent (only for entries created by the user)
 * 4. Removes PII fields from oldData/newData JSON
 * 5. Preserves non-PII audit data (tableName, action, timestamps)
 *
 * @param db - Drizzle database instance
 * @param auditTable - The audit log table
 * @param userId - User ID to purge
 * @param config - Optional configuration
 * @returns Result with count of affected records
 *
 * @example
 * ```typescript
 * import { purgeUserData } from 'drizzle-ledger/gdpr';
 * import { auditLog } from 'drizzle-ledger';
 *
 * const result = await purgeUserData(db, auditLog, 'user-123', {
 *   piiFields: ['email', 'name', 'ip', 'address', 'phone'],
 * });
 *
 * console.log(`Anonymized ${result.entriesAnonymized} audit entries`);
 * ```
 */
export async function purgeUserData(
  db: DrizzleDb,
  auditTable: AuditLog,
  userId: string,
  config?: PurgeConfig,
): Promise<PurgeResult> {
  const piiFields = config?.piiFields ?? DEFAULT_PII_FIELDS;
  const anonymizedUserId = config?.anonymizedUserId ?? DEFAULT_ANONYMIZED_USER_ID;

  // Find all audit entries for this user
  // Match by userId (who performed action) OR recordId (the user's record)
  const entries = await db
    .select()
    .from(auditTable)
    .where(or(eq(auditTable.userId, userId), eq(auditTable.recordId, userId)));

  if (entries.length === 0) {
    return {
      entriesAnonymized: 0,
      tablesProcessed: [],
    };
  }

  // Track unique tables processed
  const tablesProcessed = new Set<string>();
  let entriesAnonymized = 0;

  // Process each entry
  for (const entry of entries) {
    tablesProcessed.add(entry.tableName);

    // Parse and anonymize JSON data
    const oldData = safeJsonParse(entry.oldData);
    const newData = safeJsonParse(entry.newData);

    const anonymizedOldData = anonymizeJsonData(oldData, piiFields);
    const anonymizedNewData = anonymizeJsonData(newData, piiFields);

    // Update the entry
    // Only anonymize userId/ip/userAgent when entry.userId matches the purged user
    // This preserves admin PII when they modified the user's record
    // biome-ignore lint/suspicious/noExplicitAny: Required for Drizzle ORM dynamic operations
    await (db.update(auditTable) as any)
      .set({
        userId: entry.userId === userId ? anonymizedUserId : entry.userId,
        ip: entry.userId === userId ? null : entry.ip,
        userAgent: entry.userId === userId ? null : entry.userAgent,
        oldData: anonymizedOldData ? JSON.stringify(anonymizedOldData) : null,
        newData: anonymizedNewData ? JSON.stringify(anonymizedNewData) : null,
      })
      .where(eq(auditTable.id, entry.id));

    entriesAnonymized++;
  }

  return {
    entriesAnonymized,
    tablesProcessed: Array.from(tablesProcessed),
  };
}

/**
 * Check if a user's data has already been purged.
 * Useful for idempotency checks.
 *
 * @param db - Drizzle database instance
 * @param auditTable - The audit log table
 * @param userId - User ID to check
 * @returns true if no audit entries exist with this userId
 */
export async function isUserDataPurged(
  db: DrizzleDb,
  auditTable: AuditLog,
  userId: string,
): Promise<boolean> {
  const entries = await db.select().from(auditTable).where(eq(auditTable.userId, userId));

  return entries.length === 0;
}
