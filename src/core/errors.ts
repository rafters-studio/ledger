/**
 * Ledger Errors
 *
 * ORM-agnostic error types used across the library.
 */

/**
 * Error thrown when soft-delete is performed successfully.
 * Check for this error type to handle soft-delete success cases.
 */
export class SoftDeletePerformedError extends Error {
  readonly code = "SOFT_DELETE_PERFORMED" as const;
  readonly softDeleted = true as const;
  readonly userId: string;

  constructor(userId: string) {
    super("User soft-deleted successfully");
    this.name = "SoftDeletePerformedError";
    this.userId = userId;
  }
}

/**
 * Check if an error is a soft-delete success error.
 *
 * @param error - The error to check
 * @returns true if this is a soft-delete success
 *
 * @example
 * ```typescript
 * try {
 *   await auth.api.deleteUser({ userId });
 * } catch (error) {
 *   if (isSoftDeletePerformed(error)) {
 *     // Success! User was soft-deleted
 *     return { success: true };
 *   }
 *   throw error;
 * }
 * ```
 */
export function isSoftDeletePerformed(error: unknown): error is SoftDeletePerformedError {
  if (error instanceof SoftDeletePerformedError) return true;
  if (error instanceof Error) {
    return (
      "code" in error &&
      (error as Error & { code?: string }).code === "SOFT_DELETE_PERFORMED" &&
      "softDeleted" in error &&
      (error as Error & { softDeleted?: boolean }).softDeleted === true
    );
  }
  return false;
}
