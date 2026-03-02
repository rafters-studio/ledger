/// <reference path="./globals.d.ts" />
/**
 * Drizzle Ledger Context
 *
 * AsyncLocalStorage-based context for passing audit information through
 * the async call stack without explicit parameter threading.
 *
 * @example
 * ```typescript
 * // In middleware
 * app.use(async (c, next) => {
 *   return runWithLedgerContext({
 *     userId: c.get('user')?.id ?? null,
 *     ip: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? null,
 *     userAgent: c.req.header('user-agent') ?? null,
 *     endpoint: `${c.req.method} ${c.req.path}`,
 *     requestId: c.get('requestId'),
 *   }, next);
 * });
 *
 * // Anywhere in your code
 * const context = getLedgerContext();
 * console.log(context?.userId); // Access current user
 * ```
 */

import type { LedgerContext } from "./types.js";

// Use global AsyncLocalStorage (Cloudflare Workers compatible)
// Do NOT import from 'node:async_hooks' - it doesn't exist in Workers runtime

/**
 * Lazily initialized AsyncLocalStorage instance for ledger context.
 * This allows context to flow through async operations without explicit passing.
 * Lazy initialization ensures the global is available when first accessed.
 * Returns null if AsyncLocalStorage is not available (graceful degradation).
 */
let ledgerStorage: AsyncLocalStorage<LedgerContext> | null = null;
let storageInitialized = false;

function getStorage(): AsyncLocalStorage<LedgerContext> | null {
  if (!storageInitialized) {
    storageInitialized = true;
    // Check if AsyncLocalStorage is available (not available in some test environments)
    if (typeof AsyncLocalStorage !== "undefined") {
      ledgerStorage = new AsyncLocalStorage<LedgerContext>();
    }
  }
  return ledgerStorage;
}

/**
 * Run a function with the given ledger context.
 * All async operations within the callback will have access to this context.
 *
 * @param context - The audit context for this execution
 * @param fn - The function to run with the context
 * @returns The result of the function
 *
 * @example
 * ```typescript
 * const result = await runWithLedgerContext(
 *   { userId: 'user-123', ip: '1.2.3.4', userAgent: null, endpoint: 'POST /mods' },
 *   async () => {
 *     // All DB operations here will use this context for audit logging
 *     return await createMod(data);
 *   }
 * );
 * ```
 */
export function runWithLedgerContext<T>(
  context: LedgerContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const storage = getStorage();
  // If AsyncLocalStorage is not available, just run the function without context
  if (!storage) {
    return fn();
  }
  return storage.run(context, fn);
}

/**
 * Get the current ledger context.
 * Returns null if called outside of a runWithLedgerContext callback.
 *
 * @returns The current context or null
 *
 * @example
 * ```typescript
 * const context = getLedgerContext();
 * if (context) {
 *   console.log(`Action by user ${context.userId} from ${context.ip}`);
 * }
 * ```
 */
export function getLedgerContext(): LedgerContext | null {
  const storage = getStorage();
  if (!storage) {
    return null;
  }
  return storage.getStore() ?? null;
}

/**
 * Check if we're currently running within a ledger context.
 *
 * @returns true if a context is available
 */
export function hasLedgerContext(): boolean {
  const storage = getStorage();
  if (!storage) {
    return false;
  }
  return storage.getStore() !== undefined;
}

/**
 * Create a context object from common request properties.
 * Convenience function for creating context in middleware.
 *
 * @param options - Request properties
 * @returns A LedgerContext object
 *
 * @example
 * ```typescript
 * const context = createLedgerContext({
 *   userId: session?.user?.id,
 *   ip: req.headers['x-forwarded-for'],
 *   userAgent: req.headers['user-agent'],
 *   endpoint: `${req.method} ${req.url}`,
 * });
 * ```
 */
export function createLedgerContext(options: {
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  endpoint?: string | null;
  requestId?: string;
  metadata?: Record<string, unknown>;
}): LedgerContext {
  return {
    userId: options.userId ?? null,
    ip: options.ip ?? null,
    userAgent: options.userAgent ?? null,
    endpoint: options.endpoint ?? null,
    requestId: options.requestId,
    metadata: options.metadata,
  };
}

/**
 * Create a system context for operations not triggered by a user request.
 * Useful for cron jobs, migrations, or background workers.
 *
 * @param source - Identifier for the system process (e.g., 'cron:cleanup', 'migration:v2')
 * @param metadata - Optional additional metadata
 * @returns A LedgerContext with userId as null
 *
 * @example
 * ```typescript
 * await runWithLedgerContext(
 *   createSystemContext('cron:expired-sessions-cleanup'),
 *   async () => {
 *     await cleanupExpiredSessions();
 *   }
 * );
 * ```
 */
export function createSystemContext(
  source: string,
  metadata?: Record<string, unknown>,
): LedgerContext {
  return {
    userId: null,
    ip: null,
    userAgent: null,
    endpoint: `system:${source}`,
    requestId: undefined,
    metadata,
  };
}
