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
    embed,
    recognizeImage: vi.fn(async () => ({ text: "" })),
    listModels: vi.fn(async () => [] as ModelInfo[]),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1, message: "ok" }) as TestResult),
  };
}

async function setup() {
  const embed = vi.fn(async ({ texts }: { texts: string[] }) => ({ vectors: texts.map(() => [1]), dimension: 1 }));
  const adapter = fakeEmbedAdapter(embed);
  const t = await createTestApp({ adapterFactories: { "openai-compatible": () => adapter, "anthropic": () => adapter } });
  const { cookie, userId } = await t.signIn();
  await t.services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test", "ai.model.embedding": "openrouter://test-embed-model" });
  const runner = createJobRunner({ db: t.db, handlers: { embedding: t.services.searchService.handler } });
  return { t, cookie, userId, embed, runner };
}

async function uploadWithText(t: Awaited<ReturnType<typeof setup>>["t"], userId: string, name: string, text: string) {
  const { document } = await t.services.documentsService.upload({ userId, name, mimeType: "text/plain", body: Readable.from([text]) });
  await t.db.run(sql`update documents set extracted_text = ${text}, extraction_status = 'done' where id = ${document.id}`);
  return document.id;
}

describe("search routes", () => {
  it("requires a session on every route", async () => {
    const { app } = await createTestApp();
    expect((await app.request("/api/search?q=apple")).status).toBe(401);
    expect((await app.request("/api/search/reembed-all", { method: "POST" })).status).toBe(401);
  });

  it("returns results for a query over HTTP", async () => {
    const { t, cookie, userId, runner } = await setup();
    const documentId = await uploadWithText(t, userId, "apple.txt", "Fresh apple pie recipe.");
    await t.services.jobsService.enqueue({ userId, type: "embedding", payload: { documentId, userId } });
    await runner.runOnce();

    const res = await t.app.request("/api/search?q=apple", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.query).toBe("apple");
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ documentId, documentName: "apple.txt" });
  });

  it("returns 400 for a missing q param", async () => {
    const { t, cookie } = await setup();
    const res = await t.app.request("/api/search", { headers: { cookie } });
    expect(res.status).toBe(400);
  });

  it("queues embedding jobs for reembed-all", async () => {
    const { t, cookie, userId } = await setup();
    await uploadWithText(t, userId, "one.txt", "One document.");
    await uploadWithText(t, userId, "two.txt", "Two document.");

    const res = await t.app.request("/api/search/reembed-all", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.jobIds).toHaveLength(2);
  });
});
