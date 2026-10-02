import { DatabaseSync } from "node:sqlite";
import { SqliteDialect } from "kysely";

/** A Kysely SQLite dialect over node:sqlite, so tests run against real SQLite. */
export function nodeSqliteDialect(db: DatabaseSync): SqliteDialect {
  return new SqliteDialect({
    database: {
      close: () => db.close(),
      prepare(text) {
        const statement = db.prepare(text);
        return {
          reader: statement.columns().length > 0,
          all: (parameters) => statement.all(...(parameters as never[])),
          run: (parameters) => {
            const result = statement.run(...(parameters as never[]));
            return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
          },
          iterate: (parameters) => statement.iterate(...(parameters as never[])),
        };
      },
    },
  });
}
