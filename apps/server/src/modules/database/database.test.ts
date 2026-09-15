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
});
