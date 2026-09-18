import { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import { createJobRunner } from "../jobs/jobs.runner.js";
import type { AiAdapter, ModelInfo, StructuredResult, TestResult } from "../ai/ai.types.js";
import { createFieldsRepository } from "../fields/fields.repository.js";

function fakeAdapter(replyRef: { current: unknown }): AiAdapter {
  return {
    generateStructured: vi.fn(async () => ({ data: replyRef.current, usage: { promptTokens: 10, completionTokens: 10 } }) as StructuredResult),
    streamText: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    streamChat: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    embed: vi.fn(async () => ({ vectors: [], dimension: 0 })),
    recognizeImage: vi.fn(async () => ({ text: "" })),
    listModels: vi.fn(async () => [] as ModelInfo[]),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1, message: "ok" }) as TestResult),
  };
}

async function setup() {
  const replyRef = { current: { summary: "A short summary.", suggestedTitle: "Better Title", documentDate: "2026-03-05" } as unknown };
  const adapter = fakeAdapter(replyRef);
  const t = await createTestApp({ adapterFactories: { "openai-compatible": () => adapter, "anthropic": () => adapter } });
  const { userId } = await t.signIn();
  await t.services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test", "ai.model.rules": "openrouter://test-model" });
  const runner = createJobRunner({ db: t.db, handlers: { summarize: t.services.summaryService.handler } });
  return { t, userId, replyRef, runner };
}

async function uploadWithText(t: Awaited<ReturnType<typeof setup>>["t"], userId: string, text: string) {
  const { document } = await t.services.documentsService.upload({ userId, name: "invoice.txt", mimeType: "text/plain", body: Readable.from([text]) });
  await t.db.run(sql`update documents set extracted_text = ${text}, extraction_status = 'done' where id = ${document.id}`);
  return document.id;
}

async function setupBackfillTest() {
  const { t, userId } = await setup();
  const jobs = t.services.jobsService;

  const bareId = await uploadWithText(t, userId, "bare document text");

  const withFieldsId = await uploadWithText(t, userId, "document with fields already");
  await createFieldsRepository({ db: t.db }).replaceForDocument({
    userId,
    documentId: withFieldsId,
    fields: [{ key: "documentType", value: "invoice", valueNumber: null, valueDate: null, currency: null, confidence: null }],
  });

  const { document: pendingDoc } = await t.services.documentsService.upload({
    userId,
    name: "pending.txt",
    mimeType: "text/plain",
    body: Readable.from(["pending extraction"]),
  });
  const pendingId = pendingDoc.id; // Left at its default extractionStatus of "pending".

  const trashedId = await uploadWithText(t, userId, "trashed document text");
  await t.db.run(sql`update documents set deleted_at = ${new Date().toISOString()} where id = ${trashedId}`);

  return { t, userId, jobs, bareId, withFieldsId, pendingId, trashedId };
}

describe("summary service, summarize job", () => {
  it("generates and stores a summary and suggested title", async () => {
    const { t, userId, runner } = await setup();
    const documentId = await uploadWithText(t, userId, "Invoice for March rent, due on the 5th.");
    await t.services.jobsService.enqueue({ userId, type: "summarize", payload: { documentId, userId } });
    expect(await runner.runOnce()).toBe(1);

    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.summary).toBe("A short summary.");
    expect(document.suggestedTitle).toBe("Better Title");
    expect(document.documentDate).toBe("2026-03-05");
    expect(document.summaryStatus).toBe("done");
    expect(document.summaryError).toBeNull();
  });

  it("stores a null documentDate when the model finds no clear date", async () => {
    const { t, userId, runner, replyRef } = await setup();
    replyRef.current = { summary: "A short summary.", suggestedTitle: "Better Title", documentDate: null };
    const documentId = await uploadWithText(t, userId, "Some undated note.");
    await t.services.jobsService.enqueue({ userId, type: "summarize", payload: { documentId, userId } });
    expect(await runner.runOnce()).toBe(1);

    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.documentDate).toBeNull();
  });

  it("marks done with no summary when the extracted text is empty", async () => {
    const { t, userId, runner } = await setup();
    const { document } = await t.services.documentsService.upload({ userId, name: "empty.txt", mimeType: "text/plain", body: Readable.from(["  "]) });
    await t.db.run(sql`update documents set extracted_text = '', extraction_status = 'done' where id = ${document.id}`);
    await t.services.jobsService.enqueue({ userId, type: "summarize", payload: { documentId: document.id, userId } });
    expect(await runner.runOnce()).toBe(1);

    const after = await t.services.documentsService.get({ userId, documentId: document.id });
    expect(after.summaryStatus).toBe("done");
    expect(after.summary).toBeNull();
    expect(after.suggestedTitle).toBeNull();
    expect(after.documentDate).toBeNull();
  });

  it("reverts to pending and records the error when the model call fails", async () => {
    const throwingAdapter = {
      generateStructured: vi.fn(async () => {
        throw new Error("provider is down");
      }),
      streamText: vi.fn(),
      streamChat: vi.fn(),
      embed: vi.fn(),
      recognizeImage: vi.fn(),
      listModels: vi.fn(async () => []),
      testConnection: vi.fn(),
    };
    const t = await createTestApp({ adapterFactories: { "openai-compatible": () => throwingAdapter as never, "anthropic": () => throwingAdapter as never } });
    const { userId } = await t.signIn();
    await t.services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test", "ai.model.rules": "openrouter://test-model" });
    const documentId = await uploadWithText(t, userId, "Some text");
    const runner = createJobRunner({ db: t.db, handlers: { summarize: t.services.summaryService.handler } });
    await t.services.jobsService.enqueue({ userId, type: "summarize", payload: { documentId, userId } });
    expect(await runner.runOnce()).toBe(1);

    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.summaryStatus).toBe("pending");
    expect(document.summaryError).toContain("provider is down");
  });

  it("writes the fields the model returned", async () => {
    const { t, userId, runner, replyRef } = await setup();
    replyRef.current = {
      summary: "A bill from Acme.",
      suggestedTitle: "Acme invoice",
      documentDate: "2026-01-05",
      fields: [
        { key: "documentType", value: "invoice", confidence: 0.95 },
        { key: "amountTotal", value: "120.50", currency: "USD", confidence: 0.9 },
      ],
    };
    const documentId = await uploadWithText(t, userId, "Invoice from Acme for 120.50 USD.");
    await t.services.jobsService.enqueue({ userId, type: "summarize", payload: { documentId, userId } });
    expect(await runner.runOnce()).toBe(1);

    const rows = await createFieldsRepository({ db: t.db }).listByDocument({ userId, documentId });
    expect(rows.map((r) => r.key).sort()).toEqual(["amountTotal", "documentType"]);
    expect(rows.find((r) => r.key === "amountTotal")?.valueNumber).toBe(120.5);
    expect(rows.find((r) => r.key === "amountTotal")?.currency).toBe("USD");
  });

  it("keeps the good fields and still finishes when one row is bad", async () => {
    const { t, userId, runner, replyRef } = await setup();
    replyRef.current = {
      summary: "A bill.",
      suggestedTitle: "Bill",
      documentDate: null,
      fields: [
        { key: "documentType", value: "not-a-real-type" },
        { key: "counterparty", value: "Acme Ltd" },
      ],
    };
    const documentId = await uploadWithText(t, userId, "Some bill text.");
    await t.services.jobsService.enqueue({ userId, type: "summarize", payload: { documentId, userId } });
    expect(await runner.runOnce()).toBe(1);

    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.summaryStatus).toBe("done");
    const rows = await createFieldsRepository({ db: t.db }).listByDocument({ userId, documentId });
    expect(rows.map((r) => r.key)).toEqual(["counterparty"]);
  });

  it("replaces fields rather than duplicating them when the summary runs again", async () => {
    const { t, userId, runner, replyRef } = await setup();
    replyRef.current = { summary: "s", suggestedTitle: "t", documentDate: null, fields: [{ key: "counterparty", value: "Acme" }] };
    const documentId = await uploadWithText(t, userId, "text");
    await t.services.jobsService.enqueue({ userId, type: "summarize", payload: { documentId, userId } });
    expect(await runner.runOnce()).toBe(1);
    await t.services.jobsService.enqueue({ userId, type: "summarize", payload: { documentId, userId } });
    expect(await runner.runOnce()).toBe(1);

    const rows = await createFieldsRepository({ db: t.db }).listByDocument({ userId, documentId });
    expect(rows).toHaveLength(1);
  });

  it("finishes cleanly when the model returns no fields key at all", async () => {
    const { t, userId, runner, replyRef } = await setup();
    replyRef.current = { summary: "s", suggestedTitle: "t", documentDate: null };
    const documentId = await uploadWithText(t, userId, "text");
    await t.services.jobsService.enqueue({ userId, type: "summarize", payload: { documentId, userId } });
    expect(await runner.runOnce()).toBe(1);

    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.summaryStatus).toBe("done");
    expect(await createFieldsRepository({ db: t.db }).listByDocument({ userId, documentId })).toEqual([]);
  });

  // The reply schema parses the whole object in one pass and throws on any nested
  // failure, so asserting the shape of `fields` would let a malformed array take the
  // summary, the title, and the document date down with it. A local model reached
  // through Ollama or a custom endpoint can answer like this even in structured mode.
  it("keeps the summary when the model sends fields as something other than an array", async () => {
    const { t, userId, runner, replyRef } = await setup();
    replyRef.current = {
      summary: "A real summary.",
      suggestedTitle: "A real title",
      documentDate: "2026-03-01",
      fields: "none",
    };
    const documentId = await uploadWithText(t, userId, "text");
    await t.services.jobsService.enqueue({ userId, type: "summarize", payload: { documentId, userId } });
    expect(await runner.runOnce()).toBe(1);

    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.summaryStatus).toBe("done");
    expect(document.summary).toBe("A real summary.");
    expect(document.suggestedTitle).toBe("A real title");
    expect(document.documentDate).toBe("2026-03-01");
    expect(await createFieldsRepository({ db: t.db }).listByDocument({ userId, documentId })).toEqual([]);
  });

  it("keeps the good rows when the fields array holds something that is not an object", async () => {
    const { t, userId, runner, replyRef } = await setup();
    replyRef.current = {
      summary: "A real summary.",
      suggestedTitle: "A real title",
      documentDate: null,
      fields: ["a bare string", { key: "counterparty", value: "Acme Ltd" }, null],
    };
    const documentId = await uploadWithText(t, userId, "text");
    await t.services.jobsService.enqueue({ userId, type: "summarize", payload: { documentId, userId } });
    expect(await runner.runOnce()).toBe(1);

    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.summaryStatus).toBe("done");
    expect(document.summary).toBe("A real summary.");
    const rows = await createFieldsRepository({ db: t.db }).listByDocument({ userId, documentId });
    expect(rows.map((r) => r.key)).toEqual(["counterparty"]);
  });
});

describe("summary service, enqueueBackfill", () => {
  it("enqueues only documents that have no fields yet", async () => {
    const { t, userId, jobs, bareId } = await setupBackfillTest();
    const result = await t.services.summaryService.enqueueBackfill({ userId });
    expect(result.enqueued).toBe(1);
    const enqueued = (await jobs.list({ userId })).filter((j) => j.type === "summarize");
    expect(enqueued).toHaveLength(1);
    expect(JSON.parse(enqueued[0]!.payload).documentId).toBe(bareId);
  });

  it("skips a document that already has a summarize job in flight", async () => {
    const { t, userId, jobs, bareId } = await setupBackfillTest();
    await jobs.enqueue({ userId, type: "summarize", payload: { documentId: bareId, userId } });
    const result = await t.services.summaryService.enqueueBackfill({ userId });
    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("ignores documents whose extraction is not done and documents in the trash", async () => {
    const { t, userId } = await setupBackfillTest();
    const result = await t.services.summaryService.enqueueBackfill({ userId });
    expect(result.enqueued).toBe(1);
  });
});

describe("summary service, acceptTitle", () => {
  it("applies the suggested title and clears it", async () => {
    const { t, userId } = await setup();
    const documentId = await uploadWithText(t, userId, "text");
    await t.db.run(sql`update documents set suggested_title = 'Better Name' where id = ${documentId}`);

    const document = await t.services.summaryService.acceptTitle({ userId, documentId });
    expect(document.name).toBe("Better Name");
    expect(document.suggestedTitle).toBeNull();

    const stored = await t.services.documentsService.get({ userId, documentId });
    expect(stored.name).toBe("Better Name");
    expect(stored.suggestedTitle).toBeNull();
  });

  it("is a no-op when there is no suggestion", async () => {
    const { t, userId } = await setup();
    const documentId = await uploadWithText(t, userId, "text");
    const before = await t.services.documentsService.get({ userId, documentId });

    const after = await t.services.summaryService.acceptTitle({ userId, documentId });
    expect(after.name).toBe(before.name);
    expect(after.suggestedTitle).toBeNull();
  });

  it("throws documents.not_found for a missing document", async () => {
    const { t, userId } = await setup();
    await expectAppError(() => t.services.summaryService.acceptTitle({ userId, documentId: "doc_0000000000000000" }), "documents.not_found");
  });
});
