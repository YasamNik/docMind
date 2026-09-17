import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import { createJobRunner } from "../jobs/jobs.runner.js";
import type { AiAdapter, ModelInfo, StructuredResult, TestResult } from "../ai/ai.types.js";
import type { OcrEngine } from "./ocr.js";
import { pdfWithText } from "./test-fixtures.js";

function fakeVisionAdapter(recognizeImage: AiAdapter["recognizeImage"]): AiAdapter {
  return {
    generateStructured: vi.fn(async () => ({ data: {}, usage: { promptTokens: 0, completionTokens: 0 } }) as StructuredResult),
    streamText: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    embed: vi.fn(async () => ({ vectors: [], dimension: 0 })),
    recognizeImage,
    listModels: vi.fn(async () => [] as ModelInfo[]),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1, message: "ok" }) as TestResult),
  };
}

let root: string;
let t: Awaited<ReturnType<typeof createTestApp>>;
let userId: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docmind-extract-"));
  t = await createTestApp({ env: { DOCUMENT_STORAGE_ROOT: root } });
  userId = (await t.signIn()).userId;
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("extraction", () => {
  it("upload enqueues an extraction job and the runner fills extracted text", async () => {
    const { document } = await t.services.documentsService.upload({ userId, name: "notes.txt", mimeType: "text/plain", body: Readable.from(["hello extraction"]) });
    const pending = await t.services.jobsService.list({ userId, status: "pending" });
    expect(pending.map((j) => JSON.parse(j.payload).documentId)).toEqual([document.id]);
    expect(await t.services.jobsService.list({ userId })).toHaveLength(1);

    const runner = createJobRunner({ db: t.db, handlers: { extraction: t.services.extractionService.handler } });
    expect(await runner.runOnce()).toBe(1);
    const after = await t.services.documentsService.get({ userId, documentId: document.id });
    expect(after).toMatchObject({ extractionStatus: "done", extractedText: "hello extraction", extractionError: null });
  });

  it("extracts a PDF text layer and records a note for a scanned PDF", async () => {
    const { document } = await t.services.documentsService.upload({ userId, name: "a.pdf", mimeType: "application/pdf", body: Readable.from([Buffer.from(pdfWithText("Invoice 123"))]) });
    const runner = createJobRunner({ db: t.db, handlers: { extraction: t.services.extractionService.handler } });
    await runner.runOnce();
    expect((await t.services.documentsService.get({ userId, documentId: document.id })).extractedText).toContain("Invoice 123");
  });

  it("uses the injected OCR engine for images", async () => {
    const { document } = await t.services.documentsService.upload({ userId, name: "scan.png", mimeType: "image/png", body: Readable.from([Buffer.from([137, 80, 78, 71])]) });
    const runner = createJobRunner({ db: t.db, handlers: { extraction: t.services.extractionService.handler } });
    await runner.runOnce();
    expect((await t.services.documentsService.get({ userId, documentId: document.id })).extractedText).toBe("OCR TEXT");
  });

  it("fails the document and the job when no extractor matches", async () => {
    const { document } = await t.services.documentsService.upload({ userId, name: "archive.zip", mimeType: "application/zip", body: Readable.from(["zip"]) });
    const runner = createJobRunner({ db: t.db, handlers: { extraction: t.services.extractionService.handler } });
    await runner.runOnce();
    let doc = await t.services.documentsService.get({ userId, documentId: document.id });
    expect(doc.extractionStatus).toBe("pending");
    expect(doc.extractionError).toMatch(/No extractor for application\/zip/);
    let [job] = await t.services.jobsService.list({ userId });
    expect(job).toMatchObject({ status: "pending", attempts: 1 });
    expect(job?.error).toMatch(/No extractor/);

    const { sql } = await import("drizzle-orm");
    for (let i = 0; i < 2; i += 1) {
      await t.db.run(sql`update jobs set available_at = '2000-01-01T00:00:00.000Z' where id = ${job!.id}`);
      await runner.runOnce();
    }
    doc = await t.services.documentsService.get({ userId, documentId: document.id });
    expect(doc.extractionStatus).toBe("failed");
    expect(doc.ruleStatus).toBe("failed");
    expect(doc.ruleError).toBe("Extraction failed");
    expect(doc.embeddingStatus).toBe("failed");
    expect(doc.embeddingError).toBe("Extraction failed");
    expect(doc.summaryStatus).toBe("failed");
    expect(doc.summaryError).toBe("Extraction failed");
    [job] = await t.services.jobsService.list({ userId });
    expect(job).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("requestExtraction resets status to pending and enqueues again", async () => {
    const { document } = await t.services.documentsService.upload({ userId, name: "notes.txt", mimeType: "text/plain", body: Readable.from(["x"]) });
    const runner = createJobRunner({ db: t.db, handlers: { extraction: t.services.extractionService.handler } });
    await runner.runOnce();
    const job = await t.services.extractionService.requestExtraction({ userId, documentId: document.id });
    expect(job.type).toBe("extraction");
    expect((await t.services.documentsService.get({ userId, documentId: document.id })).extractionStatus).toBe("pending");
    expect(await t.services.jobsService.list({ userId })).toHaveLength(2);
  });

  it("destroys the file stream when no extractor matches", async () => {
    await t.services.documentsService.upload({ userId, name: "archive.zip", mimeType: "application/zip", body: Readable.from(["zip"]) });
    const original = t.services.documentsService.openFile.bind(t.services.documentsService);
    let capturedStream: Readable | undefined;
    const spy = vi.spyOn(t.services.documentsService, "openFile").mockImplementation(async (args) => {
      const result = await original(args);
      capturedStream = result.stream as Readable;
      return result;
    });
    const runner = createJobRunner({ db: t.db, handlers: { extraction: t.services.extractionService.handler } });
    await runner.runOnce();
    expect(capturedStream?.destroyed).toBe(true);
    spy.mockRestore();
  });

  it("enqueues an initial rules job when at least one automatic item exists", async () => {
    await t.services.tagsService.createTag({ userId, name: "Rent", description: "Monthly rent payments" });
    const { document } = await t.services.documentsService.upload({ userId, name: "notes.txt", mimeType: "text/plain", body: Readable.from(["rent due"]) });
    const runner = createJobRunner({ db: t.db, handlers: { extraction: t.services.extractionService.handler } });
    await runner.runOnce();

    const after = await t.services.documentsService.get({ userId, documentId: document.id });
    expect(after.ruleStatus).toBe("pending");
    const jobs = await t.services.jobsService.list({ userId, status: "pending" });
    const rulesJob = jobs.find((j) => j.type === "rules");
    expect(rulesJob).toBeDefined();
    expect(JSON.parse(rulesJob!.payload)).toMatchObject({ documentId: document.id, userId, mode: "initial" });
  });

  it("enqueues an embedding job when an embedding model is configured", async () => {
    const adapter: AiAdapter = {
      generateStructured: vi.fn(async () => ({ data: {}, usage: { promptTokens: 0, completionTokens: 0 } }) as StructuredResult),
      streamText: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
      embed: vi.fn(async () => ({ vectors: [], dimension: 0 })),
      recognizeImage: vi.fn(async () => ({ text: "" })),
      listModels: vi.fn(async () => [] as ModelInfo[]),
      testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1, message: "ok" }) as TestResult),
    };
    const app = await createTestApp({ env: { DOCUMENT_STORAGE_ROOT: root }, adapterFactories: { "openai-compatible": () => adapter, "anthropic": () => adapter } });
    const uid = (await app.signIn()).userId;
    await app.services.settingsService.set(uid, { "ai.openrouter.apiKey": "sk-or-v1-test", "ai.model.embedding": "openrouter://test-embed-model" });
    const { document } = await app.services.documentsService.upload({ userId: uid, name: "notes.txt", mimeType: "text/plain", body: Readable.from(["hello embeddings"]) });
    const runner = createJobRunner({ db: app.db, handlers: { extraction: app.services.extractionService.handler } });
    await runner.runOnce();

    const after = await app.services.documentsService.get({ userId: uid, documentId: document.id });
    expect(after.embeddingStatus).toBe("pending");
    const jobs = await app.services.jobsService.list({ userId: uid, status: "pending" });
    const embeddingJob = jobs.find((j) => j.type === "embedding");
    expect(embeddingJob).toBeDefined();
    expect(JSON.parse(embeddingJob!.payload)).toMatchObject({ documentId: document.id, userId: uid });
  });

  it("does not enqueue an embedding job when no embedding model is configured", async () => {
    const { document } = await t.services.documentsService.upload({ userId, name: "notes.txt", mimeType: "text/plain", body: Readable.from(["hello"]) });
    const runner = createJobRunner({ db: t.db, handlers: { extraction: t.services.extractionService.handler } });
    await runner.runOnce();

    const after = await t.services.documentsService.get({ userId, documentId: document.id });
    expect(after.embeddingStatus).toBe("done");
    const jobs = await t.services.jobsService.list({ userId });
    expect(jobs.filter((j) => j.type === "embedding")).toHaveLength(0);
  });

  it("sets rule_status done directly when there are no automatic items", async () => {
    const { document } = await t.services.documentsService.upload({ userId, name: "notes.txt", mimeType: "text/plain", body: Readable.from(["hello"]) });
    const runner = createJobRunner({ db: t.db, handlers: { extraction: t.services.extractionService.handler } });
    await runner.runOnce();

    const after = await t.services.documentsService.get({ userId, documentId: document.id });
    expect(after.ruleStatus).toBe("done");
    const jobs = await t.services.jobsService.list({ userId });
    expect(jobs.filter((j) => j.type === "rules")).toHaveLength(0);
  });

  it("does not create a duplicate job while one is already active", async () => {
    const { document } = await t.services.documentsService.upload({ userId, name: "notes.txt", mimeType: "text/plain", body: Readable.from(["x"]) });
    const first = await t.services.extractionService.requestExtraction({ userId, documentId: document.id });
    const second = await t.services.extractionService.requestExtraction({ userId, documentId: document.id });
    expect(second.id).toBe(first.id);
    expect(await t.services.jobsService.list({ userId })).toHaveLength(1);

    const runner = createJobRunner({ db: t.db, handlers: { extraction: t.services.extractionService.handler } });
    await runner.runOnce();
    const third = await t.services.extractionService.requestExtraction({ userId, documentId: document.id });
    expect(third.id).not.toBe(first.id);
    expect(await t.services.jobsService.list({ userId })).toHaveLength(2);
  });

  it("rejects requestExtraction for a document that does not exist, without queuing a job", async () => {
    await expectAppError(() => t.services.extractionService.requestExtraction({ userId, documentId: "doc_0000000000000000" }), "documents.not_found");
    expect(await t.services.jobsService.list({ userId })).toHaveLength(0);
  });
});

describe("vision LLM OCR fallback", () => {
  const lowConfidenceOcr: OcrEngine = {
    recognize: async () => ({ text: "garbled", confidence: 30 }),
    terminate: async () => {},
  };
  const highConfidenceOcr: OcrEngine = {
    recognize: async () => ({ text: "good text", confidence: 85 }),
    terminate: async () => {},
  };

  async function setupWithOcr(ocrEngine: OcrEngine, recognizeImage: AiAdapter["recognizeImage"]) {
    const root = await mkdtemp(join(tmpdir(), "docmind-extract-vision-"));
    const adapter = fakeVisionAdapter(recognizeImage);
    const app = await createTestApp({
      env: { DOCUMENT_STORAGE_ROOT: root },
      ocrEngine,
      adapterFactories: { "openai-compatible": () => adapter, "anthropic": () => adapter },
    });
    const { userId: uid } = await app.signIn();
    const runner = createJobRunner({ db: app.db, handlers: { extraction: app.services.extractionService.handler } });
    return { app, root, userId: uid, runner };
  }

  async function uploadImage(app: Awaited<ReturnType<typeof createTestApp>>, uid: string) {
    return app.services.documentsService.upload({
      userId: uid,
      name: "scan.png",
      mimeType: "image/png",
      body: Readable.from([Buffer.from([137, 80, 78, 71])]),
    });
  }

  it("uses vision fallback when OCR confidence is below threshold", async () => {
    const recognizeImage = vi.fn(async () => ({ text: "Clean extracted text" }));
    const { app, root, userId: uid, runner } = await setupWithOcr(lowConfidenceOcr, recognizeImage);
    try {
      await app.services.settingsService.set(uid, {
        "ai.openrouter.apiKey": "sk-or-v1-test",
        "ai.model.vision": "openrouter://test-vision-model",
      });
      const { document } = await uploadImage(app, uid);
      await runner.runOnce();
      const after = await app.services.documentsService.get({ userId: uid, documentId: document.id });
      expect(after.extractedText).toBe("Clean extracted text");
      expect(after.extractionError).toContain("Extracted by vision LLM");
      expect(recognizeImage).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps OCR result when vision slot is not configured", async () => {
    const recognizeImage = vi.fn(async () => ({ text: "Clean extracted text" }));
    const { app, root, userId: uid, runner } = await setupWithOcr(lowConfidenceOcr, recognizeImage);
    try {
      const { document } = await uploadImage(app, uid);
      await runner.runOnce();
      const after = await app.services.documentsService.get({ userId: uid, documentId: document.id });
      expect(after.extractedText).toBe("garbled");
      expect(after.extractionError).toBeFalsy();
      expect(recognizeImage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps OCR result when confidence is above threshold", async () => {
    const recognizeImage = vi.fn(async () => ({ text: "Clean extracted text" }));
    const { app, root, userId: uid, runner } = await setupWithOcr(highConfidenceOcr, recognizeImage);
    try {
      await app.services.settingsService.set(uid, {
        "ai.openrouter.apiKey": "sk-or-v1-test",
        "ai.model.vision": "openrouter://test-vision-model",
      });
      const { document } = await uploadImage(app, uid);
      await runner.runOnce();
      const after = await app.services.documentsService.get({ userId: uid, documentId: document.id });
      expect(after.extractedText).toBe("good text");
      expect(recognizeImage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps OCR result when vision LLM call fails", async () => {
    const recognizeImage = vi.fn(async () => {
      throw new Error("vision provider unavailable");
    });
    const { app, root, userId: uid, runner } = await setupWithOcr(lowConfidenceOcr, recognizeImage);
    try {
      await app.services.settingsService.set(uid, {
        "ai.openrouter.apiKey": "sk-or-v1-test",
        "ai.model.vision": "openrouter://test-vision-model",
      });
      const { document } = await uploadImage(app, uid);
      await runner.runOnce();
      const after = await app.services.documentsService.get({ userId: uid, documentId: document.id });
      expect(after.extractedText).toBe("garbled");
      expect(after.extractionError).toContain("Vision LLM fallback failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
