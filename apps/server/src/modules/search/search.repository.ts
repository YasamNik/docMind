import { asc, eq, sql } from "drizzle-orm";
import type { Database } from "../database/database.js";
import { documentChunksTable } from "./search.tables.js";
import type { DocumentChunk, NewDocumentChunk } from "./search.types.js";

const DEFAULT_KEYWORD_LIMIT = 10;
const DEFAULT_VECTOR_LIMIT = 10;

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
// each whitespace-delimited token in double quotes makes FTS5 treat it as a literal phrase
// token instead, so a user query can never be parsed as an FTS5 operator expression.
function escapeFts5Query(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" ");
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
    async searchVector(embedding: number[], limit = DEFAULT_VECTOR_LIMIT): Promise<VectorSearchRow[]> {
      const vectorJson = JSON.stringify(embedding);
      return db.all<VectorSearchRow>(sql`
        SELECT id AS chunkId,
               document_id AS documentId,
               chunk_text AS chunkText,
               chunk_index AS chunkIndex,
               vector_distance_cos(emb, vector(${vectorJson})) AS distance
        FROM document_chunks
        WHERE emb IS NOT NULL
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
  };
}

export type SearchRepository = ReturnType<typeof createSearchRepository>;
