import { createError, isAppError } from "../../shared/errors/errors.js";
import { createLogger, type Logger } from "../../shared/logger/logger.js";
import { parseOrValidationError } from "../../shared/http/validate.js";
import type { AiService } from "../ai/ai.usecases.js";
import type { Database } from "../database/database.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import type { JobHandler } from "../jobs/jobs.runner.js";
import { createJobsService } from "../jobs/jobs.usecases.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import { chunkText, estimateTokens, reciprocalRankFusion } from "./search.models.js";
import { createSearchRepository, type KeywordSearchRow, type VectorSearchRow } from "./search.repository.js";
import { embeddingJobPayloadSchema } from "./search.schemas.js";
import type { NewDocumentChunk, SearchResult } from "./search.types.js";

const EMBED_BATCH_SIZE = 20;
const KEYWORD_RESULT_LIMIT = 20;
const VECTOR_RESULT_LIMIT = 20;
const DEFAULT_SEARCH_LIMIT = 10;
const ACTIVE_DIMENSION_KEY = "ai.embedding.activeDimension";

function nowIso(): string {
  return new Date().toISOString();
}

function batches<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

// Preserves the first occurrence of each id: rows arrive already ranked best-first, so the
// first occurrence is the row's best-ranked chunk for that document.
function dedupeOrderedIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function bestRowByDocument<T extends { documentId: string }>(rows: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    if (!map.has(row.documentId)) map.set(row.documentId, row);
  }
  return map;
}

export function createSearchService({
  db,
  aiService,
  settingsService,
  logger = createLogger("search"),
}: {
  db: Database;
  aiService: Pick<AiService, "embed">;
  settingsService: SettingsService;
  logger?: Logger;
}) {
  const repository = createSearchRepository({ db });
  const documentsRepository = createDocumentsRepository({ db });
  const jobsService = createJobsService({ db });

  function parseEmbeddingPayload(raw: string) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw createError({ code: "search.invalid_payload", message: "Embedding job payload is not valid JSON", status: 500 });
    }
    return parseOrValidationError(embeddingJobPayloadSchema, value);
  }

  // Confirms (or records, on first use) the embedding column's dimension for this user's
  // active embedding model, then makes sure the column exists. A mismatch means the model
  // changed since the last embed and existing vectors cannot simply be overwritten in place.
  async function reconcileDimension(userId: string, dimension: number): Promise<void> {
    const activeDimension = await settingsService.get<number>(userId, ACTIVE_DIMENSION_KEY);
    if (activeDimension && activeDimension !== dimension) {
      throw createError({
        code: "search.dimension_mismatch",
        message: `The embedding model's dimension (${dimension}) does not match the active dimension (${activeDimension}). Change the embedding model back, or clear existing embeddings before switching.`,
        status: 409,
      });
    }
    if (!activeDimension) {
      await settingsService.setInternal(userId, ACTIVE_DIMENSION_KEY, dimension);
    }
    await repository.ensureEmbeddingColumn(dimension);
  }

  const handler: JobHandler = async (job) => {
    const { documentId, userId } = parseEmbeddingPayload(job.payload);
    const document = await documentsRepository.findById({ userId, documentId });
    if (!document) return; // Deleted between enqueue and execution.

    const text = document.extractedText ?? "";
    if (text.trim().length === 0) {
      // Zero-text documents have nothing to chunk or embed. This is a normal outcome, not
      // a failure: the document simply contributes nothing to search.
      await documentsRepository.update({ userId, documentId, patch: { embeddingStatus: "done", embeddingError: null, updatedAt: nowIso() } });
      return;
    }

    await documentsRepository.update({ userId, documentId, patch: { embeddingStatus: "processing", updatedAt: nowIso() } });

    try {
      const pieces = chunkText(text);
      // Re-embed is idempotent: drop any prior chunks for this document before inserting
      // the fresh set, so the FTS5 index and the emb column never carry stale rows.
      await repository.deleteChunksByDocument(documentId);

      if (pieces.length === 0) {
        await documentsRepository.update({ userId, documentId, patch: { embeddingStatus: "done", embeddingError: null, updatedAt: nowIso() } });
        return;
      }

      const newChunks: NewDocumentChunk[] = pieces.map((piece, index) => ({
        documentId,
        chunkIndex: index,
        chunkText: piece.text,
        tokenCount: estimateTokens(piece.text),
        startChar: piece.startChar,
        endChar: piece.endChar,
      }));
      await repository.insertChunks(newChunks);
      const inserted = await repository.findChunksByDocument(documentId);

      let dimensionReconciled = false;
      for (const batch of batches(inserted, EMBED_BATCH_SIZE)) {
        const { vectors, dimension } = await aiService.embed({ userId, task: "embedding", texts: batch.map((c) => c.chunkText) });
        if (!dimensionReconciled) {
          await reconcileDimension(userId, dimension);
          dimensionReconciled = true;
        }
        await Promise.all(
          batch.map((chunk, i) => {
            const vector = vectors[i];
            if (!vector) return Promise.resolve();
            return repository.updateChunkEmbedding(chunk.id, vector);
          }),
        );
      }

      await documentsRepository.update({ userId, documentId, patch: { embeddingStatus: "done", embeddingError: null, updatedAt: nowIso() } });
    } catch (error) {
      const message = ((error as Error).message ?? String(error)).slice(0, 2000);
      logger.warn({ userId, documentId, err: message }, "Embedding job failed");
      await documentsRepository.update({ userId, documentId, patch: { embeddingStatus: "pending", embeddingError: message, updatedAt: nowIso() } });
      throw error;
    }
  };

  async function search({ userId, query, limit = DEFAULT_SEARCH_LIMIT }: { userId: string; query: string; limit?: number }): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const keywordRows = await repository.searchKeyword(trimmed, KEYWORD_RESULT_LIMIT);

    let vectorRows: VectorSearchRow[] = [];
    try {
      const { vectors } = await aiService.embed({ userId, task: "embedding", texts: [trimmed] });
      const queryVector = vectors[0];
      if (queryVector) vectorRows = await repository.searchVector(queryVector, VECTOR_RESULT_LIMIT);
    } catch (error) {
      // No embedding model configured: fall back to keyword-only search. Any other
      // failure (a misconfigured or unreachable provider) is a real error and propagates.
      if (!isAppError(error) || error.code !== "ai.slot_not_configured") throw error;
    }

    const keywordIds = dedupeOrderedIds(keywordRows.map((r) => r.documentId));
    const vectorIds = dedupeOrderedIds(vectorRows.map((r) => r.documentId));
    const fused = reciprocalRankFusion(vectorIds, keywordIds).slice(0, limit);

    const keywordByDocument = bestRowByDocument<KeywordSearchRow>(keywordRows);
    const vectorByDocument = bestRowByDocument<VectorSearchRow>(vectorRows);

    const documents = await Promise.all(fused.map((f) => documentsRepository.findById({ userId, documentId: f.documentId })));

    const results: SearchResult[] = [];
    fused.forEach((entry, index) => {
      const document = documents[index];
      if (!document) return; // Deleted since it was chunked.
      const keywordHit = keywordByDocument.get(entry.documentId);
      const vectorHit = vectorByDocument.get(entry.documentId);
      const chosen = keywordHit ?? vectorHit;
      if (!chosen) return;
      const source: SearchResult["source"] = keywordHit && vectorHit ? "hybrid" : keywordHit ? "keyword" : "vector";
      results.push({
        documentId: entry.documentId,
        documentName: document.name,
        chunkText: chosen.chunkText,
        chunkIndex: chosen.chunkIndex,
        score: entry.score,
        source,
      });
    });
    return results;
  }

  async function reembedAll({ userId }: { userId: string }): Promise<{ count: number; jobIds: string[] }> {
    const documents = await documentsRepository.listByUser({ userId, view: "all" });
    const extracted = documents.filter((d) => d.extractionStatus === "done");
    const jobIds: string[] = [];
    for (const document of extracted) {
      const job = await jobsService.enqueue({ userId, type: "embedding", payload: { documentId: document.id, userId } });
      jobIds.push(job.id);
    }
    return { count: jobIds.length, jobIds };
  }

  return { handler, search, reembedAll };
}

export type SearchService = ReturnType<typeof createSearchService>;
