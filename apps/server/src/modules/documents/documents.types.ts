import type { ExtractedField } from "../fields/fields.types.js";
import type { TagChip } from "../tags/tags.types.js";
import type { documentsTable } from "./documents.tables.js";

export type Document = typeof documentsTable.$inferSelect;
export type NewDocument = typeof documentsTable.$inferInsert;
export type DocumentView = "inbox" | "needs_review" | "all" | "trash";
export type DocumentTriageStatus = "pending" | "reviewed";
export type DocumentListRow = Omit<Document, "extractedText"> & {
  categoryPath: string | null;
  // Optional rather than required like categoryPath: tags.routes.ts builds its own
  // enriched document shape for the category routes and does not carry this field yet.
  // Task 4 (document type routes) adds it there when it wires up manual type setting.
  documentTypeName?: string | null;
  tags: TagChip[];
  fields: ExtractedField[];
};
