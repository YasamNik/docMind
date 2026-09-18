import type { TagChip } from "../tags/tags.types.js";
import type { documentsTable } from "./documents.tables.js";

export type Document = typeof documentsTable.$inferSelect;
export type NewDocument = typeof documentsTable.$inferInsert;
export type DocumentView = "inbox" | "needs_review" | "all";
export type DocumentTriageStatus = "pending" | "reviewed";
export type DocumentListRow = Omit<Document, "extractedText"> & { categoryPath: string | null; tags: TagChip[] };
