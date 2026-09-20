import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { documentsTable } from "../documents/documents.tables.js";

// One vocabulary for both a receipt as a whole and its line items, the way tags.tables.ts
// shapes document_types: name, description, colour, automatic.
export const budgetCategoriesTable = sqliteTable(
  "budget_categories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    color: text("color"),
    autoApply: integer("auto_apply").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("budget_categories_user_idx").on(t.userId),
    uniqueIndex("budget_categories_user_name_idx").on(t.userId, sql`${t.name} COLLATE NOCASE`),
  ],
);

export const budgetReceiptsTable = sqliteTable(
  "budget_receipts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    // Page 1's photo. Cascade: deleting the document should take the receipt record
    // pointing at it, the same rule documents.parentDocumentId already uses for pages.
    documentId: text("document_id")
      .notNull()
      .references(() => documentsTable.id, { onDelete: "cascade" }),
    merchant: text("merchant"),
    // The receipt's own category, set by the model and correctable. A grocery run that
    // also contains a kettle is still a groceries receipt with an appliance item, so this
    // is never derived from the items, it is its own read.
    categoryId: text("category_id").references(() => budgetCategoriesTable.id, { onDelete: "set null" }),
    purchasedAt: text("purchased_at"),
    currency: text("currency"),
    total: real("total"),
    taxAmount: real("tax_amount"),
    status: text("status").notNull().default("pending"),
    note: text("note"),
    duplicateOfReceiptId: text("duplicate_of_receipt_id").references((): AnySQLiteColumn => budgetReceiptsTable.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("budget_receipts_user_purchased_idx").on(t.userId, t.purchasedAt),
    uniqueIndex("budget_receipts_user_document_idx").on(t.userId, t.documentId),
  ],
);

export const budgetReceiptItemsTable = sqliteTable(
  "budget_receipt_items",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    receiptId: text("receipt_id")
      .notNull()
      .references(() => budgetReceiptsTable.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    description: text("description").notNull(),
    quantity: real("quantity"),
    unitPrice: real("unit_price"),
    amount: real("amount").notNull(),
    categoryId: text("category_id").references(() => budgetCategoriesTable.id, { onDelete: "set null" }),
    categorySource: text("category_source"),
    confidence: real("confidence"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("budget_receipt_items_receipt_line_idx").on(t.receiptId, t.lineNumber)],
);
