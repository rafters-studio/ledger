import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/core/index.ts",
    "drizzle/index": "src/drizzle/index.ts",
    "drizzle/schema/index": "src/drizzle/schema/index.ts",
    "drizzle/schema/sqlite": "src/drizzle/schema/sqlite.ts",
    "drizzle/schema/pg": "src/drizzle/schema/pg.ts",
    "drizzle/schema/mysql": "src/drizzle/schema/mysql.ts",
    "drizzle/soft-delete/sqlite": "src/drizzle/soft-delete/sqlite.ts",
    "drizzle/soft-delete/pg": "src/drizzle/soft-delete/pg.ts",
    "drizzle/soft-delete/mysql": "src/drizzle/soft-delete/mysql.ts",
    "better-auth": "src/better-auth.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  external: ["drizzle-orm", "better-auth"],
});
