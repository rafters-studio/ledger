import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
  resolve: {
    alias: {
      "@ezmode-games/drizzle-ledger/soft-delete/sqlite": "./src/soft-delete/sqlite.ts",
      "@ezmode-games/drizzle-ledger/soft-delete/pg": "./src/soft-delete/pg.ts",
      "@ezmode-games/drizzle-ledger/soft-delete/mysql": "./src/soft-delete/mysql.ts",
      "@ezmode-games/drizzle-ledger/soft-delete": "./src/soft-delete/index.ts",
      "@ezmode-games/drizzle-ledger/schema/sqlite": "./src/schema/sqlite.ts",
      "@ezmode-games/drizzle-ledger/schema/pg": "./src/schema/pg.ts",
      "@ezmode-games/drizzle-ledger/schema/mysql": "./src/schema/mysql.ts",
      "@ezmode-games/drizzle-ledger/schema": "./src/schema/index.ts",
      "@ezmode-games/drizzle-ledger/audit": "./src/audit.ts",
      "@ezmode-games/drizzle-ledger/context": "./src/context.ts",
      "@ezmode-games/drizzle-ledger/db": "./src/db.ts",
      "@ezmode-games/drizzle-ledger/gdpr": "./src/gdpr.ts",
      "@ezmode-games/drizzle-ledger/logger": "./src/logger.ts",
      "@ezmode-games/drizzle-ledger/better-auth": "./src/better-auth.ts",
      "@ezmode-games/drizzle-ledger": "./src/index.ts",
    },
  },
});
