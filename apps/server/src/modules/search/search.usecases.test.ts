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
    expect(results).toEqual([{ documentId: document.id, documentName: "banana.txt", chunkText: "Banana bread recipe.", chunkIndex: 0, score: expect.any(Number), source: "keyword", storageDriver: "local" }]);
  });

  it("returns an empty list for a blank query", async () => {
    const { t, userId } = await setupWithEmbedding();
    expect(await t.services.searchService.search({ userId, query: "   " })).toEqual([]);
  });

  it("says which storage holds each result, whatever the active storage is", async () => {
    const { t, userId, runner } = await setupWithEmbedding();
    const documentId = await uploadWithText(t, userId, "apple.txt", "Fresh apple pie recipe.");
    await t.db.run(sql`update documents set storage_driver = 's3' where id = ${documentId}`);
    await enqueueAndRun(t, runner, userId, documentId);

    const results = await t.services.searchService.search({ userId, query: "apple" });

    expect(results[0]?.storageDriver).toBe("s3");
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

// Distances chosen to match what a real embedding model produces on a small corpus: the
// right document lands around 0.6 and everything else sits near 0.8, so the gap between
// them carries the signal rather than the absolute number.
const ANGLED_QUERY = [1, 0, 0];
const ANGLED_NEAR = [0.4, 0.9165151389911681, 0]; // cosine distance 0.6 from the query
const ANGLED_FAR = [0.2, 0, 0.9797958971132712]; // cosine distance 0.8 from the query

// Maps exact texts to vectors, so a test states outright which document the query is
// near instead of relying on a keyword appearing in both the query and the document.
async function setupWithAngledEmbedding(vectorByText: Map<string, number[]>) {
  const embed = vi.fn(async ({ texts }: { texts: string[] }) => ({
    vectors: texts.map((text) => vectorByText.get(text) ?? ANGLED_FAR),
    dimension: 3,
  }));
  const adapter = fakeEmbedAdapter(embed);
  const t = await createTestApp({ adapterFactories: { "openai-compatible": () => adapter, "anthropic": () => adapter } });
  const { userId } = await t.signIn();
  await t.services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test", "ai.model.embedding": "openrouter://test-embed-model" });
  const runner = createJobRunner({ db: t.db, handlers: { embedding: t.services.searchService.handler } });
  return { t, userId, runner };
}

describe("search service, recall", () => {
  it("returns the nearest document when its distance is beyond the old fixed cutoff", async () => {
    const licenceText = "Ontario Driver's Licence, expires 2028/10/22.";
    const invoiceText = "Invoice for plumbing work, total 240 dollars.";
    const { t, userId, runner } = await setupWithAngledEmbedding(
      new Map([
        ["driver license", ANGLED_QUERY],
        [licenceText, ANGLED_NEAR],
        [invoiceText, ANGLED_FAR],
      ]),
    );
    // The filename shares no word with the query, and the text says licence while the
    // query says license, so neither the keyword nor the filename path can find this.
    // Only the vector path can, which is exactly what the fixed 0.55 cutoff suppressed.
    const licenceDoc = await uploadWithText(t, userId, "ontario-card.txt", licenceText);
    const invoiceDoc = await uploadWithText(t, userId, "bill.txt", invoiceText);
    await enqueueAndRun(t, runner, userId, licenceDoc);
    await enqueueAndRun(t, runner, userId, invoiceDoc);

    const results = await t.services.searchService.search({ userId, query: "driver license" });

    expect(results[0]?.documentId).toBe(licenceDoc);
    expect(results.map((r) => r.documentId)).not.toContain(invoiceDoc);
  });

  it("matches a natural language question on the words that carry meaning", async () => {
    const t = await createTestApp();
    const { userId } = await t.signIn();
    const { document } = await t.services.documentsService.upload({ userId, name: "card.txt", mimeType: "text/plain", body: Readable.from(["Ontario Driver's Licence, expires 2028."]) });
    const { createSearchRepository } = await import("./search.repository.js");
    const repository = createSearchRepository({ db: t.db });
    await repository.insertChunks([{ documentId: document.id, chunkIndex: 0, chunkText: "Ontario Driver's Licence, expires 2028.", tokenCount: 6, startChar: 0, endChar: 39 }]);

    const results = await t.services.searchService.search({ userId, query: "where is my driver licence?" });

    expect(results.map((r) => r.documentId)).toEqual([document.id]);
  });

  it("returns nothing for a question made only of common words", async () => {
    const t = await createTestApp();
    const { userId } = await t.signIn();
    const { document } = await t.services.documentsService.upload({ userId, name: "card.txt", mimeType: "text/plain", body: Readable.from(["Ontario Driver's Licence, expires 2028."]) });
    const { createSearchRepository } = await import("./search.repository.js");
    const repository = createSearchRepository({ db: t.db });
    await repository.insertChunks([{ documentId: document.id, chunkIndex: 0, chunkText: "Ontario Driver's Licence, expires 2028.", tokenCount: 6, startChar: 0, endChar: 39 }]);

    expect(await t.services.searchService.search({ userId, query: "where is it" })).toEqual([]);
  });

  it("keeps documents that only share generic wording out of the results", async () => {
    // The shape that matters for chat: one document the query is actually about, and
    // others that merely repeat the boilerplate every bill carries. Fusion ranks by list
    // position, so without pruning the weak keyword matches these three would arrive with
    // a high enough score to be handed to the model as evidence.
    const question = "what is the total amount due on my hydro bill";
    const hydroText = "Hydro One bill for the summer. Account 42. Total amount due: 180 dollars.";
    const decoys = [
      { name: "plumb.txt", text: "Plumbing repair invoice. Total amount due: 240 dollars." },
      { name: "grocery.txt", text: "Supermarket receipt. Total amount due: 54 dollars." },
      { name: "gym.txt", text: "Membership renewal notice. Total amount due: 30 dollars." },
    ];
    const { t, userId, runner } = await setupWithAngledEmbedding(
      new Map([
        [question, ANGLED_QUERY],
        [hydroText, ANGLED_NEAR],
      ]),
    );
    const hydroDoc = await uploadWithText(t, userId, "utility.txt", hydroText);
    await enqueueAndRun(t, runner, userId, hydroDoc);
    for (const decoy of decoys) {
      const id = await uploadWithText(t, userId, decoy.name, decoy.text);
      await enqueueAndRun(t, runner, userId, id);
    }

    const results = await t.services.searchService.search({ userId, query: question });

    expect(results.map((r) => r.documentId)).toEqual([hydroDoc]);
  });
});
