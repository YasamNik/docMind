import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { documentsTable } from "../documents/documents.tables.js";

// The emb column (F32_BLOB, dimension depends on the configured embedding model) is
// added at runtime via ALTER TABLE, not defined here: Drizzle has no F32_BLOB type and
// the dimension is not known at migration time.
export const documentChunksTable = sqliteTable(
  "document_chunks",
  {
    // Integer autoincrement PK, required so the FTS5 content table can sync on rowid.
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentId: text("document_id")
      .notNull()
      .references(() => documentsTable.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    chunkText: text("chunk_text").notNull(),
    tokenCount: integer("token_count").notNull(),
    startChar: integer("start_char").notNull(),
    endChar: integer("end_char").notNull(),
  },
  (t) => [index("document_chunks_document_chunk_idx").on(t.documentId, t.chunkIndex)],
);
