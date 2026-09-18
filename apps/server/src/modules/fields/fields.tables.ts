import { index, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { documentsTable } from "../documents/documents.tables.js";

export const documentFieldsTable = sqliteTable(
  "document_fields",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    documentId: text("document_id")
      .notNull()
      .references(() => documentsTable.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    valueNumber: real("value_number"),
    valueDate: text("value_date"),
    // Set on the amount rows only. Each amount carries its own currency, so per-row
    // validation can never leave a currency with no amount beside it.
    currency: text("currency"),
    confidence: real("confidence"),
    source: text("source").notNull().default("llm"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("document_fields_document_key_idx").on(t.documentId, t.key),
    index("document_fields_user_key_idx").on(t.userId, t.key),
  ],
);
