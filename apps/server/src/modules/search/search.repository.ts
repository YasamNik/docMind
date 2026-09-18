import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../database/database.js";
import { meaningfulQueryTokens } from "./search.models.js";
import { documentChunksTable, savedSearchesTable } from "./search.tables.js";
import type { DocumentChunk, NewDocumentChunk } from "./search.types.js";

const DEFAULT_KEYWORD_LIMIT = 10;
const DEFAULT_VECTOR_LIMIT = 10;
// Cosine distance past which a chunk is treated as unrelated to the query whatever else
// the corpus holds. Measured on text-embedding-3-large, where a correct match lands near
// 0.6 and unrelated text sits at 0.79 and above.
const MAX_VECTOR_DISTANCE = 0.78;

export type KeywordSearchRow = {
  chunkId: number;
  documentId: string;
  chunkText: string;
  chunkIndex: number;
  rank: number;
};

export type VectorSearchRow = {
  chunkId: number;
  documentId: string;
  chunkText: string;
  chunkIndex: number;
  distance: number;
};

// FTS5 MATCH treats *, -, +, (, ), :, ^, ~, and bare AND/OR/NOT as query syntax. Wrapping
// each token in double quotes makes FTS5 treat it as a literal phrase token instead, so a
// user query can never be parsed as an FTS5 operator expression.
//
// The tokens are joined with OR, not FTS5's implicit AND. A question asks for a document
// in the user's words, not in the document's, so requiring every word to appear in one
// chunk finds nothing. Ranking sorts out which of the OR matches is worth showing: bm25
// weighs a rare word far above a common one, and the caller fuses this list with the
// vector list before anything is returned.
export function escapeFts5Query(query: string): string {
  return meaningfulQueryTokens(query)
    .map((token) => `"${token.replace(/"/g, '""')}"*`)
    .join(" OR ");
}

export function createSearchRepository({ db }: { db: Database }) {
  return {
    async insertChunks(chunks: NewDocumentChunk[], tx: Database = db): Promise<void> {
      if (chunks.length === 0) return;
      await tx.insert(documentChunksTable).values(chunks);
    },

    async deleteChunksByDocument(documentId: string, tx: Database = db): Promise<void> {
      await tx.delete(documentChunksTable).where(eq(documentChunksTable.documentId, documentId));
    },

    async findChunksByDocument(documentId: string): Promise<DocumentChunk[]> {
      return db
        .select()
        .from(documentChunksTable)
        .where(eq(documentChunksTable.documentId, documentId))
        .orderBy(asc(documentChunksTable.chunkIndex));
    },

    // document_chunks_fts is an external-content FTS5 table that only exposes the
    // chunk_text column plus the implicit rowid and rank, so document_id and the chunk
    // row itself come from a join back to document_chunks on rowid = id.
    async searchKeyword(query: string, limit = DEFAULT_KEYWORD_LIMIT): Promise<KeywordSearchRow[]> {
      const escaped = escapeFts5Query(query);
      if (escaped.length === 0) return [];
      return db.all<KeywordSearchRow>(sql`
        SELECT document_chunks.id AS chunkId,
               document_chunks.document_id AS documentId,
               document_chunks.chunk_text AS chunkText,
               document_chunks.chunk_index AS chunkIndex,
               document_chunks_fts.rank AS rank
        FROM document_chunks_fts
        JOIN document_chunks ON document_chunks.id = document_chunks_fts.rowid
        WHERE document_chunks_fts MATCH ${escaped}
        ORDER BY document_chunks_fts.rank
        LIMIT ${limit}
      `);
    },

    // Brute-force cosine distance over the emb column using libsql's native vector
    // functions. vector() parses a JSON array string into the F32_BLOB representation.
    //
    // maxDistance is a sanity bound, not a relevance test: it keeps a corpus with nothing
    // relevant in it from filling the chat context with noise. Which of the rows under it
    // are actually relevant is decided by withinDistanceMargin in the usecase, because
    // absolute distances shift with the embedding model while the gap between a good match
    // and the rest does not.
    async searchVector(embedding: number[], limit = DEFAULT_VECTOR_LIMIT, maxDistance = MAX_VECTOR_DISTANCE): Promise<VectorSearchRow[]> {
      const vectorJson = JSON.stringify(embedding);
      return db.all<VectorSearchRow>(sql`
        SELECT id AS chunkId,
               document_id AS documentId,
               chunk_text AS chunkText,
               chunk_index AS chunkIndex,
               vector_distance_cos(emb, vector(${vectorJson})) AS distance
        FROM document_chunks
        WHERE emb IS NOT NULL
          AND vector_distance_cos(emb, vector(${vectorJson})) < ${maxDistance}
        ORDER BY distance ASC
        LIMIT ${limit}
      `);
    },

    // Called once when the embedding pipeline first learns the active model's dimension.
    // SQLite cannot bind a parameter inside a column type declaration, so the dimension is
    // validated as a plain positive integer and inlined into the DDL text.
    async ensureEmbeddingColumn(dimension: number): Promise<void> {
      if (!Number.isInteger(dimension) || dimension <= 0) {
        throw new Error(`Invalid embedding dimension: ${dimension}`);
      }
      try {
        await db.run(sql.raw(`ALTER TABLE document_chunks ADD COLUMN emb F32_BLOB(${dimension})`));
      } catch {
        // Column already exists. Adding it again is a no-op for our purposes; the caller
        // is responsible for checking the dimension matches before writing vectors.
      }
    },

    async updateChunkEmbedding(chunkId: number, embedding: number[]): Promise<void> {
      const vectorJson = JSON.stringify(embedding);
      await db.run(sql`UPDATE document_chunks SET emb = vector(${vectorJson}) WHERE id = ${chunkId}`);
    },

    // For re-embed scenarios where the model (and so the dimension) changes. If the
    // libsql version in use rejects DROP COLUMN, the caller falls back to deleting and
    // re-inserting chunk rows so the next embed cycle recreates the column fresh.
    async dropEmbeddingColumn(): Promise<void> {
      try {
        await db.run(sql.raw("ALTER TABLE document_chunks DROP COLUMN emb"));
      } catch {
        // Column does not exist, or this libsql version cannot drop it.
      }
    },

    async insertSavedSearch(search: typeof savedSearchesTable.$inferInsert) {
      await db.insert(savedSearchesTable).values(search);
    },

    async listSavedSearches(userId: string) {
      return db.select().from(savedSearchesTable).where(eq(savedSearchesTable.userId, userId)).orderBy(desc(savedSearchesTable.updatedAt));
    },

    async findSavedSearch({ userId, id }: { userId: string; id: string }) {
      const [row] = await db.select().from(savedSearchesTable).where(and(eq(savedSearchesTable.userId, userId), eq(savedSearchesTable.id, id)));
      return row ?? null;
    },

    async updateSavedSearch({ userId, id, patch }: { userId: string; id: string; patch: Partial<typeof savedSearchesTable.$inferInsert> }) {
      await db.update(savedSearchesTable).set(patch).where(and(eq(savedSearchesTable.userId, userId), eq(savedSearchesTable.id, id)));
    },

    async deleteSavedSearch({ userId, id }: { userId: string; id: string }) {
      await db.delete(savedSearchesTable).where(and(eq(savedSearchesTable.userId, userId), eq(savedSearchesTable.id, id)));
    },
  };
}

export type SearchRepository = ReturnType<typeof createSearchRepository>;
