import { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";
import { createJobRunner } from "../jobs/jobs.runner.js";
import type { AiAdapter, ModelInfo, StructuredResult, TestResult } from "../ai/ai.types.js";

function fakeEmbedAdapter(embed: AiAdapter["embed"]): AiAdapter {
  return {
    generateStructured: vi.fn(async () => ({ data: {}, usage: { promptTokens: 0, completionTokens: 0 } }) as StructuredResult),
    streamText: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    streamChat: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    embed,
    recognizeImage: vi.fn(async () => ({ text: "" })),
    listModels: vi.fn(async () => [] as ModelInfo[]),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1, message: "ok" }) as TestResult),
  };
}

// A tiny deterministic embedding: one dimension per keyword, set to 1 when the text
// mentions that keyword. Lets vector search behave predictably without a real model.
const KEYWORDS = ["apple", "banana", "orange"];
function vectorFor(text: string): number[] {
  const lower = text.toLowerCase();
  return KEYWORDS.map((word) => (lower.includes(word) ? 1 : 0));
}

async function setupWithEmbedding() {
  const embed = vi.fn(async ({ texts }: { texts: string[] }) => ({
    vectors: texts.map((text) => vectorFor(text)),
    dimension: KEYWORDS.length,
  }));
  const adapter = fakeEmbedAdapter(embed);
  const t = await createTestApp({ adapterFactories: { "openai-compatible": () => adapter, "anthropic": () => adapter } });
  const { userId } = await t.signIn();
  await t.services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test", "ai.model.embedding": "openrouter://test-embed-model" });
  const runner = createJobRunner({ db: t.db, handlers: { embedding: t.services.searchService.handler } });
  return { t, userId, embed, runner };
}

async function uploadWithText(t: Awaited<ReturnType<typeof setupWithEmbedding>>["t"], userId: string, name: string, text: string) {
  const { document } = await t.services.documentsService.upload({ userId, name, mimeType: "text/plain", body: Readable.from([text]) });
  await t.db.run(sql`update documents set extracted_text = ${text}, extraction_status = 'done' where id = ${document.id}`);
  return document.id;
}

async function enqueueAndRun(t: Awaited<ReturnType<typeof setupWithEmbedding>>["t"], runner: ReturnType<typeof createJobRunner>, userId: string, documentId: string) {
  await t.services.jobsService.enqueue({ userId, type: "embedding", payload: { documentId, userId } });
  await runner.runOnce();
}

describe("search service, embedding job", () => {
  it("chunks a document, embeds each chunk, and marks embedding_status done", async () => {
    const { t, userId, runner } = await setupWithEmbedding();
    const text = "Fresh apple pie recipe with cinnamon and sugar.";
    const documentId = await uploadWithText(t, userId, "apple.txt", text);

    await enqueueAndRun(t, runner, userId, documentId);

    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.embeddingStatus).toBe("done");
    expect(document.embeddingError).toBeNull();

    const chunks = await t.db.all<{ chunk_text: string; chunk_index: number }>(sql`select chunk_text, chunk_index from document_chunks where document_id = ${documentId}`);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.chunk_text).toBe(text);

    const activeDimension = await t.services.settingsService.get<number>(userId, "ai.embedding.activeDimension");
    expect(activeDimension).toBe(KEYWORDS.length);
  });

  it("handles empty extracted text gracefully, with no chunks and embedding_status done", async () => {
    const { t, userId, runner } = await setupWithEmbedding();
    const documentId = await uploadWithText(t, userId, "empty.txt", "");

    await enqueueAndRun(t, runner, userId, documentId);

    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.embeddingStatus).toBe("done");
    const chunks = await t.db.all(sql`select id from document_chunks where document_id = ${documentId}`);
    expect(chunks).toHaveLength(0);
  });

  it("re-embedding a document replaces its chunks rather than duplicating them", async () => {
    const { t, userId, runner } = await setupWithEmbedding();
    const documentId = await uploadWithText(t, userId, "apple.txt", "Fresh apple pie recipe.");

    await enqueueAndRun(t, runner, userId, documentId);
    await enqueueAndRun(t, runner, userId, documentId);

    const chunks = await t.db.all(sql`select id from document_chunks where document_id = ${documentId}`);
    expect(chunks).toHaveLength(1);
  });
});

describe("search service, hybrid search", () => {
  it("ranks a document matching both keyword and vector search above one matching only vector search", async () => {
    const { t, userId, runner } = await setupWithEmbedding();
    const appleDoc = await uploadWithText(t, userId, "apple.txt", "Fresh apple pie recipe with cinnamon.");
    const orangeDoc = await uploadWithText(t, userId, "orange.txt", "Orange juice benefits for breakfast.");
    await enqueueAndRun(t, runner, userId, appleDoc);
    await enqueueAndRun(t, runner, userId, orangeDoc);

    const results = await t.services.searchService.search({ userId, query: "apple" });

    expect(results[0]).toMatchObject({ documentId: appleDoc, documentName: "apple.txt", source: "hybrid" });
    // The orange doc's vector is orthogonal to the query vector, so it exceeds the cosine
    // distance threshold and does not appear in results.
    const orangeResult = results.find((r) => r.documentId === orangeDoc);
    expect(orangeResult).toBeUndefined();
  });

  it("falls back to keyword-only search when no embedding model is configured", async () => {
    const t = await createTestApp();
    const { userId } = await t.signIn();
    const { document } = await t.services.documentsService.upload({ userId, name: "banana.txt", mimeType: "text/plain", body: Readable.from(["Banana bread recipe."]) });
    // No embedding model is configured for this user, so the normal path (the extraction
    // handler enqueueing an embedding job) never runs. Insert a chunk directly, the way the
    // embedding job would, to exercise the search() fallback in isolation.
    const { createSearchRepository } = await import("./search.repository.js");
    const repository = createSearchRepository({ db: t.db });
    await repository.insertChunks([{ documentId: document.id, chunkIndex: 0, chunkText: "Banana bread recipe.", tokenCount: 4, startChar: 0, endChar: 21 }]);

    const results = await t.services.searchService.search({ userId, query: "banana" });
    expect(results).toEqual([{ documentId: document.id, documentName: "banana.txt", chunkText: "Banana bread recipe.", chunkIndex: 0, score: expect.any(Number), source: "keyword" }]);
  });

  it("returns an empty list for a blank query", async () => {
    const { t, userId } = await setupWithEmbedding();
    expect(await t.services.searchService.search({ userId, query: "   " })).toEqual([]);
  });
});

describe("search service, reembedAll", () => {
  it("enqueues an embedding job for every document with extraction done, and skips the rest", async () => {
    const { t, userId } = await setupWithEmbedding();
    const done = await uploadWithText(t, userId, "done.txt", "Extracted already.");
    const { document: pendingDoc } = await t.services.documentsService.upload({ userId, name: "pending.txt", mimeType: "text/plain", body: Readable.from(["not yet extracted"]) });

    const result = await t.services.searchService.reembedAll({ userId });

    expect(result.count).toBe(1);
    expect(result.jobIds).toHaveLength(1);
    const jobs = await t.services.jobsService.list({ userId, status: "pending" });
    const embeddingJobs = jobs.filter((j) => j.type === "embedding");
    expect(embeddingJobs.map((j) => JSON.parse(j.payload).documentId)).toEqual([done]);
    expect(embeddingJobs.map((j) => JSON.parse(j.payload).documentId)).not.toContain(pendingDoc.id);
  });
});
