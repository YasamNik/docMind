import type { documentsTable } from "./documents.tables.js";

export type Document = typeof documentsTable.$inferSelect;
export type NewDocument = typeof documentsTable.$inferInsert;
export type DocumentListRow = Omit<Document, "extractedText">;
