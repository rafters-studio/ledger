import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
  resolve: {
    alias: {
      "@rafters/ledger/soft-delete/sqlite": "./src/soft-delete/sqlite.ts",
      "@rafters/ledger/soft-delete/pg": "./src/soft-delete/pg.ts",
      "@rafters/ledger/soft-delete/mysql": "./src/soft-delete/mysql.ts",
      "@rafters/ledger/soft-delete": "./src/soft-delete/index.ts",
      "@rafters/ledger/schema/sqlite": "./src/schema/sqlite.ts",
      "@rafters/ledger/schema/pg": "./src/schema/pg.ts",
      "@rafters/ledger/schema/mysql": "./src/schema/mysql.ts",
      "@rafters/ledger/schema": "./src/schema/index.ts",
      "@rafters/ledger/audit": "./src/audit.ts",
      "@rafters/ledger/context": "./src/context.ts",
      "@rafters/ledger/db": "./src/db.ts",
      "@rafters/ledger/gdpr": "./src/gdpr.ts",
      "@rafters/ledger/logger": "./src/logger.ts",
      "@rafters/ledger/better-auth": "./src/better-auth.ts",
      "@rafters/ledger": "./src/index.ts",
    },
  },
});
