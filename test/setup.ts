/**
 * Vitest setup file
 *
 * Provides AsyncLocalStorage as a global for Node.js testing.
 * In CF Workers runtime, this is already a global.
 */

import { AsyncLocalStorage } from "node:async_hooks";

// Make AsyncLocalStorage available globally (like in CF Workers)
globalThis.AsyncLocalStorage = AsyncLocalStorage;
