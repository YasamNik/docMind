import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { createDatabase } from "./database.js";

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

  it("creates the sort_evaluations table", async () => {
    const { db } = await createTestDatabase();
    const rows = await db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name = 'sort_evaluations'`,
    );
    expect(rows.length).toBe(1);
  });

  it("creates the document_chunks table and the documents summary columns", async () => {
    const { db } = await createTestDatabase();
    const tables = await db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name = 'document_chunks'`,
    );
    expect(tables.length).toBe(1);
    const columns = await db.all<{ name: string }>(sql`pragma table_info(documents)`);
    const names = columns.map((c) => c.name);
    expect(names).toContain("summary");
    expect(names).toContain("suggested_title");
    expect(names).toContain("summary_status");
    expect(names).toContain("summary_error");
  });

  it("creates the document_chunks_fts virtual table and content-sync triggers", async () => {
    const { db } = await createTestDatabase();
    const virtualTables = await db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name = 'document_chunks_fts'`,
    );
    expect(virtualTables.length).toBe(1);
    const triggers = await db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'trigger' and name like 'document_chunks_fts_%'`,
    );
    expect(triggers.map((t) => t.name).sort()).toEqual(["document_chunks_fts_ad", "document_chunks_fts_ai"]);
  });

  it("creates the chat_sessions and chat_messages tables", async () => {
    const { db } = await createTestDatabase();
    const tables = await db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name in ('chat_sessions', 'chat_messages')`,
    );
    expect(tables.map((t) => t.name).sort()).toEqual(["chat_messages", "chat_sessions"]);
  });

  it("cascades deletes from chat_sessions to chat_messages", async () => {
    const { db } = await createTestDatabase();
    const fkList = await db.all<{ table: string; on_delete: string }>(sql`pragma foreign_key_list(chat_messages)`);
    const sessionFk = fkList.find((fk) => fk.table === "chat_sessions");
    expect(sessionFk?.on_delete).toBe("CASCADE");
  });

  it("holds a file database to a single pooled connection", async () => {
    // An in-memory database is always a single connection regardless of client config, so
    // this has to use a real file to exercise the pool. Without forcing `concurrency: 1`,
    // a query issued while a transaction holds the only known connection would silently
    // open a second one instead of waiting for the first to be released.
    const filePath = join(tmpdir(), `docmind-test-${randomUUID()}.db`);
    const { client } = await createDatabase({ url: `file:${filePath}` });
    try {
      const tx = await client.transaction();
      try {
        await expect(client.execute("select 1")).rejects.toThrow(/single connection/i);
      } finally {
        await tx.rollback();
      }
    } finally {
      client.close();
      await rm(filePath, { force: true });
      await rm(`${filePath}-wal`, { force: true });
      await rm(`${filePath}-shm`, { force: true });
    }
  });
});
