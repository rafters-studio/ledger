/**
 * Ledger Soft Delete - Pure Helpers
 *
 * ORM-agnostic helpers for soft-delete patterns.
 * These functions have zero ORM dependencies.
 */

/**
 * Values to set when soft-deleting a record.
 *
 * @param deletedBy - Optional user ID who is deleting the record
 * @returns Object with deletedAt set to current timestamp
 */
export function softDeleteValues(deletedBy?: string | null): {
  deletedAt: Date;
  deletedBy: string | null;
} {
  return {
    deletedAt: new Date(),
    deletedBy: deletedBy ?? null,
  };
}

/**
 * Values to set when restoring a soft-deleted record.
 *
 * @returns Object with deletedAt and deletedBy set to null
 */
export function restoreValues(): {
  deletedAt: null;
  deletedBy: null;
} {
  return {
    deletedAt: null,
    deletedBy: null,
  };
}

/**
 * Check if a record is soft-deleted.
 *
 * @param record - A record with a deletedAt field
 * @returns true if the record is soft-deleted
 */
export function isSoftDeleted(record: { deletedAt: Date | null } | null | undefined): boolean {
  return record?.deletedAt !== null && record?.deletedAt !== undefined;
}

/**
 * Type helper to add soft-delete columns to a table type.
 */
export type WithSoftDelete<T> = T & {
  deletedAt: Date | null;
  deletedBy: string | null;
};

/**
 * Type helper for minimal soft-delete (just timestamp).
 */
export type WithSoftDeleteTimestamp<T> = T & {
  deletedAt: Date | null;
};
