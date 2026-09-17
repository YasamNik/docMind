import { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";
import { createJobRunner } from "../jobs/jobs.runner.js";
import type { AiAdapter, ModelInfo, StructuredResult, TestResult } from "../ai/ai.types.js";

function fakeAdapter(replyRef: { current: unknown }): AiAdapter {
  return {
    generateStructured: vi.fn(async () => ({ data: replyRef.current, usage: { promptTokens: 10, completionTokens: 10 } }) as StructuredResult),
    streamText: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    embed: vi.fn(async () => ({ vectors: [], dimension: 0 })),
    listModels: vi.fn(async () => [] as ModelInfo[]),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1, message: "ok" }) as TestResult),
  };
}

async function setup() {
  const replyRef = { current: { items: [] } as unknown };
  const adapter = fakeAdapter(replyRef);
  const t = await createTestApp({ adapterFactories: { "openai-compatible": () => adapter, "anthropic": () => adapter } });
  const { userId } = await t.signIn();
  await t.services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test", "ai.model.rules": "openrouter://test-model" });
  const runner = createJobRunner({ db: t.db, handlers: { rules: t.services.rulesService.handler } });
  return { t, userId, replyRef, runner };
}

async function uploadWithText(t: Awaited<ReturnType<typeof setup>>["t"], userId: string, text: string) {
  const { document } = await t.services.documentsService.upload({ userId, name: "invoice.txt", mimeType: "text/plain", body: Readable.from([text]) });
  await t.db.run(sql`update documents set extracted_text = ${text}, extraction_status = 'done', rule_status = 'pending' where id = ${document.id}`);
  return document.id;
}

describe("rules service, initial mode", () => {
  it("has no automatic items until a tag or category has both a description and auto_apply", async () => {
    const { t, userId } = await setup();
    expect(await t.services.rulesService.hasAutomaticItems(userId)).toBe(false);
    await t.services.tagsService.createTag({ userId, name: "Rent" });
    expect(await t.services.rulesService.hasAutomaticItems(userId)).toBe(false);
    await t.services.tagsService.createTag({ userId, name: "Utilities", description: "Utility bills" });
    expect(await t.services.rulesService.hasAutomaticItems(userId)).toBe(true);
  });

  it("applies a matched tag at or above threshold and stores an applied evaluation", async () => {
    const { t, userId, replyRef, runner } = await setup();
    const tag = await t.services.tagsService.createTag({ userId, name: "Rent", description: "Monthly rent payments" });
    replyRef.current = { items: [{ type: "tag", id: tag.id, matched: true, confidence: 0.9, reasoning: "Mentions rent." }] };
    const documentId = await uploadWithText(t, userId, "Invoice for March rent");

    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "initial" } });
    expect(await runner.runOnce()).toBe(1);

    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.ruleStatus).toBe("done");
    expect(document.tags).toEqual([{ id: tag.id, name: "Rent", color: null, auto: true, manual: false }]);
  });

  it("does not apply a matched tag below its threshold", async () => {
    const { t, userId, replyRef, runner } = await setup();
    const tag = await t.services.tagsService.createTag({ userId, name: "Rent", description: "Monthly rent payments", confidenceThreshold: 0.8 });
    replyRef.current = { items: [{ type: "tag", id: tag.id, matched: true, confidence: 0.5, reasoning: "Maybe rent." }] };
    const documentId = await uploadWithText(t, userId, "Some text");
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "initial" } });
    await runner.runOnce();

    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.tags).toEqual([]);
  });

  it("sets the highest-confidence matched category with category_source auto", async () => {
    const { t, userId, replyRef, runner } = await setup();
    const finance = await t.services.tagsService.createCategory({ userId, name: "Finance", description: "Money matters" });
    const personal = await t.services.tagsService.createCategory({ userId, name: "Personal", description: "Personal notes" });
    replyRef.current = {
      items: [
        { type: "category", id: finance.id, matched: true, confidence: 0.9, reasoning: "Invoice." },
        { type: "category", id: personal.id, matched: true, confidence: 0.4, reasoning: "Not personal." },
      ],
    };
    const documentId = await uploadWithText(t, userId, "Invoice text");
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "initial" } });
    await runner.runOnce();

    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.categoryId).toBe(finance.id);
    expect(document.categorySource).toBe("auto");
  });

  it("sets no category on a tie between two matched categories", async () => {
    const { t, userId, replyRef, runner } = await setup();
    const a = await t.services.tagsService.createCategory({ userId, name: "A", description: "First" });
    const b = await t.services.tagsService.createCategory({ userId, name: "B", description: "Second" });
    replyRef.current = {
      items: [
        { type: "category", id: a.id, matched: true, confidence: 0.8, reasoning: "x" },
        { type: "category", id: b.id, matched: true, confidence: 0.8, reasoning: "y" },
      ],
    };
    const documentId = await uploadWithText(t, userId, "Ambiguous text");
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "initial" } });
    await runner.runOnce();

    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.categoryId).toBeNull();
  });

  it("treats an item missing from the reply as no_match with confidence 0", async () => {
    const { t, userId, replyRef, runner } = await setup();
    await t.services.tagsService.createTag({ userId, name: "Rent", description: "Monthly rent" });
    replyRef.current = { items: [] };
    const documentId = await uploadWithText(t, userId, "Unrelated text");
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "initial" } });
    await runner.runOnce();

    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.tags).toEqual([]);
  });

  it("drops an unknown id from the reply without throwing", async () => {
    const { t, userId, replyRef, runner } = await setup();
    await t.services.tagsService.createTag({ userId, name: "Rent", description: "Monthly rent" });
    replyRef.current = { items: [{ type: "tag", id: "tag_ffffffffffffffff", matched: true, confidence: 0.9, reasoning: "x" }] };
    const documentId = await uploadWithText(t, userId, "Some text");
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "initial" } });
    await expect(runner.runOnce()).resolves.toBe(1);

    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.tags).toEqual([]);
  });

  it("marks rule_status done directly when the job carries no automatic items", async () => {
    const { t, userId, runner } = await setup();
    const documentId = await uploadWithText(t, userId, "No rules configured");
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "initial" } });
    await runner.runOnce();
    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.ruleStatus).toBe("done");
  });

  it("reverts rule_status to pending, not failed, when the provider call fails", async () => {
    const throwingAdapter = {
      generateStructured: vi.fn(async () => {
        throw new Error("provider is down");
      }),
      streamText: vi.fn(),
      embed: vi.fn(),
      listModels: vi.fn(async () => []),
      testConnection: vi.fn(),
    };
    const t = await createTestApp({ adapterFactories: { "openai-compatible": () => throwingAdapter as never, "anthropic": () => throwingAdapter as never } });
    const { userId } = await t.signIn();
    await t.services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test", "ai.model.rules": "openrouter://test-model" });
    await t.services.tagsService.createTag({ userId, name: "Rent", description: "Monthly rent" });
    const documentId = await uploadWithText(t, userId, "Some text");
    const runner = createJobRunner({ db: t.db, handlers: { rules: t.services.rulesService.handler } });
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "initial" } });
    await runner.runOnce();

    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.ruleStatus).toBe("pending");
  });
});
