import { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import { createJobRunner } from "../jobs/jobs.runner.js";
import type { AiAdapter, ModelInfo, StructuredResult, TestResult } from "../ai/ai.types.js";

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
