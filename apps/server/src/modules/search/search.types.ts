import type { documentChunksTable } from "./search.tables.js";

export type DocumentChunk = typeof documentChunksTable.$inferSelect;
export type NewDocumentChunk = typeof documentChunksTable.$inferInsert;

export type SearchResult = {
  documentId: string;
  documentName: string;
  chunkText: string;
  chunkIndex: number;
  score: number;
  source: "vector" | "keyword" | "hybrid";
};

export type EmbeddingJobPayload = {
  documentId: string;
  userId: string;
};
