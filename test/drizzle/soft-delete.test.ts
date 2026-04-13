import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, uuid } from "drizzle-orm/pg-core";
import { mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { describe, expect, test } from "vitest";
import { includingDeleted, notDeleted, onlyDeleted } from "../../src/drizzle/soft-delete.js";
import {
  softDeleteColumns as sqliteColumns,
  softDeleteTimestamp as sqliteTimestamp,
} from "../../src/drizzle/soft-delete/sqlite.js";
import {
  softDeleteColumns as pgColumns,
  softDeleteTimestamp as pgTimestampOnly,
} from "../../src/drizzle/soft-delete/pg.js";
import {
  softDeleteColumns as mysqlColumns,
  softDeleteTimestamp as mysqlTimestampOnly,
} from "../../src/drizzle/soft-delete/mysql.js";

// Test tables for each dialect
const sqliteUsers = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  ...sqliteColumns,
});

const pgUsers = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: pgText("name"),
  ...pgColumns,
});

const mysqlUsers = mysqlTable("users", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: varchar("name", { length: 255 }),
  ...mysqlColumns,
});

describe("softDeleteColumns - SQLite", () => {
  test("exports deletedAt and deletedBy", () => {
    expect(sqliteColumns.deletedAt).toBeDefined();
    expect(sqliteColumns.deletedBy).toBeDefined();
  });

  test("softDeleteTimestamp exports deletedAt only", () => {
    expect(sqliteTimestamp.deletedAt).toBeDefined();
    expect("deletedBy" in sqliteTimestamp).toBe(false);
  });

  test("can spread into table definition", () => {
    expect(sqliteUsers.deletedAt).toBeDefined();
    expect(sqliteUsers.deletedBy).toBeDefined();
  });
});

describe("softDeleteColumns - PostgreSQL", () => {
  test("exports deletedAt and deletedBy", () => {
    expect(pgColumns.deletedAt).toBeDefined();
    expect(pgColumns.deletedBy).toBeDefined();
  });

  test("softDeleteTimestamp exports deletedAt only", () => {
    expect(pgTimestampOnly.deletedAt).toBeDefined();
    expect("deletedBy" in pgTimestampOnly).toBe(false);
  });

  test("can spread into table definition", () => {
    expect(pgUsers.deletedAt).toBeDefined();
    expect(pgUsers.deletedBy).toBeDefined();
  });
});

describe("softDeleteColumns - MySQL", () => {
  test("exports deletedAt and deletedBy", () => {
    expect(mysqlColumns.deletedAt).toBeDefined();
    expect(mysqlColumns.deletedBy).toBeDefined();
  });

  test("softDeleteTimestamp exports deletedAt only", () => {
    expect(mysqlTimestampOnly.deletedAt).toBeDefined();
    expect("deletedBy" in mysqlTimestampOnly).toBe(false);
  });

  test("can spread into table definition", () => {
    expect(mysqlUsers.deletedAt).toBeDefined();
    expect(mysqlUsers.deletedBy).toBeDefined();
  });
});

describe("notDeleted", () => {
  test("returns SQL for SQLite table", () => {
    const condition = notDeleted(sqliteUsers);
    expect(condition).toBeDefined();
  });

  test("returns SQL for PostgreSQL table", () => {
    const condition = notDeleted(pgUsers);
    expect(condition).toBeDefined();
  });

  test("returns SQL for MySQL table", () => {
    const condition = notDeleted(mysqlUsers);
    expect(condition).toBeDefined();
  });
});

describe("onlyDeleted", () => {
  test("returns SQL for SQLite table", () => {
    const condition = onlyDeleted(sqliteUsers);
    expect(condition).toBeDefined();
  });

  test("returns SQL for PostgreSQL table", () => {
    const condition = onlyDeleted(pgUsers);
    expect(condition).toBeDefined();
  });

  test("returns SQL for MySQL table", () => {
    const condition = onlyDeleted(mysqlUsers);
    expect(condition).toBeDefined();
  });
});

describe("includingDeleted", () => {
  test("returns a SQL fragment", () => {
    const condition = includingDeleted();
    expect(condition).toBeDefined();
  });
});
