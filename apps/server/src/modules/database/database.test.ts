import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";

describe("database", () => {
  it("applies migrations to an in-memory database", async () => {
    const { db } = await createTestDatabase();
    const rows = await db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'`,
    );
    expect(rows.length).toBe(1);
  });

  it("creates the tags module tables and the documents category columns", async () => {
    const { db } = await createTestDatabase();
    const tables = await db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name in ('categories', 'tags', 'document_tags')`,
    );
    expect(tables.map((t) => t.name).sort()).toEqual(["categories", "document_tags", "tags"]);
    const columns = await db.all<{ name: string }>(sql`pragma table_info(documents)`);
    const names = columns.map((c) => c.name);
    expect(names).toContain("category_id");
    expect(names).toContain("category_source");
  });

  it("has foreign key enforcement enabled", async () => {
    const { db } = await createTestDatabase();
    const [row] = await db.all<{ foreign_keys: number }>(sql`pragma foreign_keys`);
    expect(row.foreign_keys).toBe(1);
  });
});
