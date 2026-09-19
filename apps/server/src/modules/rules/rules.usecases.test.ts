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
    streamChat: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    embed: vi.fn(async () => ({ vectors: [], dimension: 0 })),
    recognizeImage: vi.fn(async () => ({ text: "" })),
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
  it("has no automatic items until a tag, category, or type has both a description and auto_apply", async () => {
    const { t, userId } = await setup();
    // Preset document types are seeded and auto-apply by default (Task 2), so proving
    // "no automatic items" for tags and categories needs every preset removed first.
    await t.services.tagsService.ensureTypesSeeded({ userId });
    for (const type of await t.services.tagsService.listTypes(userId)) {
      await t.services.tagsService.deleteType({ userId, typeId: type.id });
    }
    expect(await t.services.rulesService.hasAutomaticItems(userId)).toBe(false);
    await t.services.tagsService.createTag({ userId, name: "Rent" });
    expect(await t.services.rulesService.hasAutomaticItems(userId)).toBe(false);
    await t.services.tagsService.createTag({ userId, name: "Utilities", description: "Utility bills" });
    expect(await t.services.rulesService.hasAutomaticItems(userId)).toBe(true);
  });

  it("counts a preset document type toward automatic items once seeded", async () => {
    const { t, userId } = await setup();
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

  it("applies the highest-confidence matched type with document_type_source auto", async () => {
    const { t, userId, replyRef, runner } = await setup();
    const quote = await t.services.tagsService.createType({ userId, name: "Quote", description: "A price offered before any work is done." });
    const handbook = await t.services.tagsService.createType({ userId, name: "Handbook", description: "Instructions shipped with a product." });
    replyRef.current = {
      items: [
        { type: "type", id: quote.id, matched: true, confidence: 0.9, reasoning: "Looks like a quote." },
        { type: "type", id: handbook.id, matched: true, confidence: 0.4, reasoning: "Not a handbook." },
      ],
    };
    const documentId = await uploadWithText(t, userId, "Quotation for works");
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "initial" } });
    await runner.runOnce();

    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.documentTypeId).toBe(quote.id);
    expect(document.documentTypeSource).toBe("auto");
  });

  it("does not apply a matched type below its threshold", async () => {
    const { t, userId, replyRef, runner } = await setup();
    const quote = await t.services.tagsService.createType({ userId, name: "Quote", description: "A price offered before any work is done.", confidenceThreshold: 0.8 });
    replyRef.current = { items: [{ type: "type", id: quote.id, matched: true, confidence: 0.5, reasoning: "Maybe a quote." }] };
    const documentId = await uploadWithText(t, userId, "Some text");
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "initial" } });
    await runner.runOnce();

    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.documentTypeId).toBeNull();
    expect(document.documentTypeSource).toBeNull();
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
      streamChat: vi.fn(),
      embed: vi.fn(),
      recognizeImage: vi.fn(),
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

describe("rules service, rerun mode and proposals", () => {
  it("proposes add_tag for a newly matched tag not yet on the document", async () => {
    const { t, userId, replyRef, runner } = await setup();
    const tag = await t.services.tagsService.createTag({ userId, name: "Rent", description: "Monthly rent" });
    const documentId = await uploadWithText(t, userId, "Invoice text");
    await t.db.run(sql`update documents set rule_status = 'done' where id = ${documentId}`);
    replyRef.current = { items: [{ type: "tag", id: tag.id, matched: true, confidence: 0.9, reasoning: "Mentions rent." }] };

    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "rerun", targetType: "tag", targetId: tag.id } });
    await runner.runOnce();

    const proposals = await t.services.rulesService.listProposalsForDocument({ userId, documentId });
    expect(proposals).toEqual([
      { id: proposals[0]!.id, documentId, documentName: "invoice.txt", targetType: "tag", targetId: tag.id, itemName: "Rent", kind: "add_tag", confidence: 0.9, reasoning: "Mentions rent." },
    ]);
  });

  it("proposes remove_tag for an automatic tag that no longer matches, never for a manual one", async () => {
    const { t, userId, replyRef, runner } = await setup();
    const auto = await t.services.tagsService.createTag({ userId, name: "Rent", description: "Monthly rent" });
    const manual = await t.services.tagsService.createTag({ userId, name: "Keep", description: "Keep this" });
    const documentId = await uploadWithText(t, userId, "Some text");
    const { createRulesRepository } = await import("./rules.repository.js");
    const repo = createRulesRepository({ db: t.db });
    await repo.setTagAutoApplied({ documentId, tagId: auto.id, applied: true });
    await t.services.tagsService.setDocumentTag({ userId, documentId, tagId: manual.id });
    await t.db.run(sql`update documents set rule_status = 'done' where id = ${documentId}`);

    replyRef.current = { items: [{ type: "tag", id: auto.id, matched: false, confidence: 0, reasoning: "No longer about rent." }] };
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "rerun", targetType: "tag", targetId: auto.id } });
    await runner.runOnce();
    let proposals = await t.services.rulesService.listProposalsForDocument({ userId, documentId });
    expect(proposals.map((p) => p.kind)).toEqual(["remove_tag"]);

    replyRef.current = { items: [{ type: "tag", id: manual.id, matched: false, confidence: 0, reasoning: "Unrelated." }] };
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "rerun", targetType: "tag", targetId: manual.id } });
    await runner.runOnce();
    proposals = await t.services.rulesService.listProposalsForDocument({ userId, documentId });
    expect(proposals.map((p) => p.kind)).toEqual(["remove_tag"]);
  });

  it("does not re-offer a dismissed proposal for the same document, item, and kind", async () => {
    const { t, userId, replyRef, runner } = await setup();
    const tag = await t.services.tagsService.createTag({ userId, name: "Rent", description: "Monthly rent" });
    const documentId = await uploadWithText(t, userId, "Invoice text");
    await t.db.run(sql`update documents set rule_status = 'done' where id = ${documentId}`);
    replyRef.current = { items: [{ type: "tag", id: tag.id, matched: true, confidence: 0.9, reasoning: "Mentions rent." }] };
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "rerun", targetType: "tag", targetId: tag.id } });
    await runner.runOnce();
    const [first] = await t.services.rulesService.listProposalsForDocument({ userId, documentId });

    await t.services.rulesService.applyProposals({ userId, accept: [], dismiss: [first!.id] });

    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "rerun", targetType: "tag", targetId: tag.id } });
    await runner.runOnce();
    expect(await t.services.rulesService.listProposalsForDocument({ userId, documentId })).toEqual([]);
  });

  it("re-offers a dismissed proposal once the item's description changes", async () => {
    const { t, userId, replyRef, runner } = await setup();
    const tag = await t.services.tagsService.createTag({ userId, name: "Rent", description: "Monthly rent" });
    const documentId = await uploadWithText(t, userId, "Invoice text");
    await t.db.run(sql`update documents set rule_status = 'done' where id = ${documentId}`);
    replyRef.current = { items: [{ type: "tag", id: tag.id, matched: true, confidence: 0.9, reasoning: "Mentions rent." }] };
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "rerun", targetType: "tag", targetId: tag.id } });
    await runner.runOnce();
    const [first] = await t.services.rulesService.listProposalsForDocument({ userId, documentId });
    await t.services.rulesService.applyProposals({ userId, accept: [], dismiss: [first!.id] });

    await t.services.tagsService.updateTag({ userId, tagId: tag.id, patch: { description: "Monthly rent, including parking" } });
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "rerun", targetType: "tag", targetId: tag.id } });
    await runner.runOnce();
    expect((await t.services.rulesService.listProposalsForDocument({ userId, documentId })).map((p) => p.kind)).toEqual(["add_tag"]);
  });

  it("proposes set_category and applies it once accepted", async () => {
    const { t, userId, replyRef, runner } = await setup();
    const category = await t.services.tagsService.createCategory({ userId, name: "Finance", description: "Money matters" });
    const documentId = await uploadWithText(t, userId, "Invoice text");
    await t.db.run(sql`update documents set rule_status = 'done' where id = ${documentId}`);
    replyRef.current = { items: [{ type: "category", id: category.id, matched: true, confidence: 0.9, reasoning: "It is an invoice." }] };
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "rerun", targetType: "category", targetId: category.id } });
    await runner.runOnce();
    const [proposal] = await t.services.rulesService.listProposalsForDocument({ userId, documentId });
    expect(proposal).toMatchObject({ kind: "set_category", itemName: "Finance" });

    const { appliedCount } = await t.services.rulesService.applyProposals({ userId, accept: [proposal!.id], dismiss: [] });
    expect(appliedCount).toBe(1);
    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.categoryId).toBe(category.id);
    expect(document.categorySource).toBe("auto");
  });

  it("never proposes set_category over a manual category", async () => {
    const { t, userId, replyRef, runner } = await setup();
    const manualCategory = await t.services.tagsService.createCategory({ userId, name: "Personal" });
    const candidate = await t.services.tagsService.createCategory({ userId, name: "Finance", description: "Money matters" });
    const documentId = await uploadWithText(t, userId, "Invoice text");
    await t.services.tagsService.setDocumentCategory({ userId, documentId, categoryId: manualCategory.id });
    await t.db.run(sql`update documents set rule_status = 'done' where id = ${documentId}`);
    replyRef.current = { items: [{ type: "category", id: candidate.id, matched: true, confidence: 0.9, reasoning: "It is an invoice." }] };
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "rerun", targetType: "category", targetId: candidate.id } });
    await runner.runOnce();
    expect(await t.services.rulesService.listProposalsForDocument({ userId, documentId })).toEqual([]);
  });

  it("proposes set_type and applies it once accepted", async () => {
    const { t, userId, replyRef, runner } = await setup();
    const quote = await t.services.tagsService.createType({ userId, name: "Quote", description: "A price offered before any work is done." });
    const documentId = await uploadWithText(t, userId, "Quotation text");
    await t.db.run(sql`update documents set rule_status = 'done' where id = ${documentId}`);
    replyRef.current = { items: [{ type: "type", id: quote.id, matched: true, confidence: 0.9, reasoning: "Looks like a quote." }] };
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "rerun", targetType: "type", targetId: quote.id } });
    await runner.runOnce();
    const [proposal] = await t.services.rulesService.listProposalsForDocument({ userId, documentId });
    expect(proposal).toMatchObject({ kind: "set_type", itemName: "Quote" });

    const { appliedCount } = await t.services.rulesService.applyProposals({ userId, accept: [proposal!.id], dismiss: [] });
    expect(appliedCount).toBe(1);
    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.documentTypeId).toBe(quote.id);
    expect(document.documentTypeSource).toBe("auto");
  });

  it("does not overwrite a manually set type on a rerun", async () => {
    const { t, userId, replyRef, runner } = await setup();
    const manualType = await t.services.tagsService.createType({ userId, name: "Handbook", description: "Instructions shipped with a product." });
    const candidate = await t.services.tagsService.createType({ userId, name: "Quote", description: "A price offered before any work is done." });
    const documentId = await uploadWithText(t, userId, "Quotation text");
    await t.db.run(sql`update documents set rule_status = 'done', document_type_id = ${manualType.id}, document_type_source = 'manual' where id = ${documentId}`);
    replyRef.current = { items: [{ type: "type", id: candidate.id, matched: true, confidence: 0.9, reasoning: "Looks like a quote." }] };
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "rerun", targetType: "type", targetId: candidate.id } });
    await runner.runOnce();

    expect(await t.services.rulesService.listProposalsForDocument({ userId, documentId })).toEqual([]);
    const document = await t.services.documentsService.get({ userId, documentId });
    expect(document.documentTypeId).toBe(manualType.id);
    expect(document.documentTypeSource).toBe("manual");
  });

  it("finishes a rerun job with no output when the target was deleted before it ran", async () => {
    const { t, userId, runner } = await setup();
    const tag = await t.services.tagsService.createTag({ userId, name: "Rent", description: "Monthly rent" });
    const documentId = await uploadWithText(t, userId, "Invoice text");
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "rerun", targetType: "tag", targetId: tag.id } });
    await t.services.tagsService.deleteTag({ userId, tagId: tag.id });
    await expect(runner.runOnce()).resolves.toBe(1);
    expect(await t.services.rulesService.listProposalsForDocument({ userId, documentId })).toEqual([]);
  });

  it("requestSort enqueues one rerun job for the whole document", async () => {
    const { t, userId } = await setup();
    const documentId = await uploadWithText(t, userId, "Invoice text");
    const job = await t.services.rulesService.requestSort({ userId, documentId });
    expect(job.type).toBe("rules");
    expect(JSON.parse((await t.services.jobsService.get({ userId, id: job.id })).payload)).toMatchObject({ documentId, mode: "rerun" });
  });

  it("runOnScope enqueues one job per document in scope and countForScope agrees", async () => {
    const { t, userId } = await setup();
    const tag = await t.services.tagsService.createTag({ userId, name: "Rent", description: "Monthly rent" });
    const a = await uploadWithText(t, userId, "a");
    const b = await uploadWithText(t, userId, "b");
    await t.db.run(sql`update documents set rule_status = 'done' where id in (${a}, ${b})`);
    const count = await t.services.rulesService.countForScope({ userId, scope: "all" });
    expect(count).toBe(2);
    const { count: runCount, jobIds } = await t.services.rulesService.runOnScope({ userId, targetType: "tag", targetId: tag.id, scope: "all" });
    expect(runCount).toBe(2);
    expect(jobIds).toHaveLength(2);
  });

  it("dryRun scores an unsaved description without storing anything", async () => {
    const { t, userId, replyRef } = await setup();
    const documentId = await uploadWithText(t, userId, "Invoice for March rent");
    replyRef.current = { items: [{ type: "tag", id: "draft", matched: true, confidence: 0.8, reasoning: "Mentions rent." }] };
    const jobsBefore = await t.services.jobsService.list({ userId });
    const result = await t.services.rulesService.dryRun({ userId, documentId, targetType: "tag", name: "Rent", description: "Monthly rent", threshold: 0.7 });
    expect(result).toEqual({ matched: true, confidence: 0.8, reasoning: "Mentions rent.", wouldApply: true });
    const jobsAfter = await t.services.jobsService.list({ userId });
    expect(jobsAfter.filter((j) => j.type === "rules")).toHaveLength(0);
    expect(jobsAfter.length).toBe(jobsBefore.length);
  });
});
