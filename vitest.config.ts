import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
  resolve: {
    alias: {
      "@rafters/ledger/drizzle/soft-delete/sqlite": "./src/drizzle/soft-delete/sqlite.ts",
      "@rafters/ledger/drizzle/soft-delete/pg": "./src/drizzle/soft-delete/pg.ts",
      "@rafters/ledger/drizzle/soft-delete/mysql": "./src/drizzle/soft-delete/mysql.ts",
      "@rafters/ledger/drizzle/soft-delete": "./src/drizzle/soft-delete.ts",
      "@rafters/ledger/drizzle/schema/sqlite": "./src/drizzle/schema/sqlite.ts",
      "@rafters/ledger/drizzle/schema/pg": "./src/drizzle/schema/pg.ts",
      "@rafters/ledger/drizzle/schema/mysql": "./src/drizzle/schema/mysql.ts",
      "@rafters/ledger/drizzle/schema": "./src/drizzle/schema/index.ts",
      "@rafters/ledger/drizzle/audit": "./src/drizzle/audit.ts",
      "@rafters/ledger/drizzle/db": "./src/drizzle/db.ts",
      "@rafters/ledger/drizzle/gdpr": "./src/drizzle/gdpr.ts",
      "@rafters/ledger/drizzle/logger": "./src/drizzle/logger.ts",
      "@rafters/ledger/drizzle": "./src/drizzle/index.ts",
      "@rafters/ledger/core/context": "./src/core/context.ts",
      "@rafters/ledger/core/soft-delete": "./src/core/soft-delete.ts",
      "@rafters/ledger/core/gdpr": "./src/core/gdpr.ts",
      "@rafters/ledger/core/errors": "./src/core/errors.ts",
      "@rafters/ledger/core": "./src/core/index.ts",
      "@rafters/ledger/better-auth": "./src/better-auth.ts",
      "@rafters/ledger": "./src/index.ts",
    },
  },
});
