import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { createTestApp } from "../../shared/test/app.test-utils.js";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import type { Database } from "../database/database.js";
import { createSettingsRegistry } from "../settings/settings.registry.js";
import { createSettingsService } from "../settings/settings.usecases.js";
import { createJobRunner } from "../jobs/jobs.runner.js";
import type { AiAdapter } from "../ai/ai.types.js";
import { budgetSettingDefinitions } from "./budget.settings.js";
import { BUDGET_CATEGORY_PRESETS } from "./budget.models.js";
import { createBudgetRepository } from "./budget.repository.js";
import { createBudgetService } from "./budget.usecases.js";

const userId = "user-1";
let db: Database;
let budget: ReturnType<typeof createBudgetService>;
let repository: ReturnType<typeof createBudgetRepository>;

function createTestBudgetService({ db }: { db: Database }) {
  const settingsService = createSettingsService({
    db,
    registry: createSettingsRegistry(budgetSettingDefinitions),
    config: { settingsEncryptionKey: "99".repeat(32), env: {} },
  });
  // Only ensureCategoriesSeeded is exercised in this describe block, so the receipt-job
  // dependencies below are never called; they exist to satisfy the constructor.
  return createBudgetService({
    db,
    settingsService,
    aiService: { generateStructuredFromImages: vi.fn() },
    documentsService: { remove: vi.fn() },
    storageService: { getDriver: vi.fn() },
  });
}

beforeEach(async () => {
  ({ db } = await createTestDatabase());
  budget = createTestBudgetService({ db });
  repository = createBudgetRepository({ db });
});

describe("budget service, preset categories", () => {
  it("seeds the preset categories once", async () => {
    await budget.ensureCategoriesSeeded({ userId });
    await budget.ensureCategoriesSeeded({ userId });
    const categories = await repository.listCategoriesRaw(userId);
    expect(categories).toHaveLength(BUDGET_CATEGORY_PRESETS.length);
    expect(categories.map((c) => c.name)).toContain("Groceries");
  });

  it("does not resurrect a preset the user deleted", async () => {
    await budget.ensureCategoriesSeeded({ userId });
    const groceries = (await repository.listCategoriesRaw(userId)).find((c) => c.name === "Groceries")!;
    await repository.deleteCategory({ userId, categoryId: groceries.id });
    await budget.ensureCategoriesSeeded({ userId });
    expect((await repository.listCategoriesRaw(userId)).map((c) => c.name)).not.toContain("Groceries");
  });

  it("keeps the user's own category when a preset wants the same name", async () => {
    const t = new Date().toISOString();
    await repository.insertCategory({
      id: "bcat_custom0000000",
      userId,
      name: "Groceries",
      description: "Mine",
      color: null,
      autoApply: 1,
      createdAt: t,
      updatedAt: t,
    });
    await budget.ensureCategoriesSeeded({ userId });
    const groceries = (await repository.listCategoriesRaw(userId)).filter((c) => c.name.toLowerCase() === "groceries");
    expect(groceries).toHaveLength(1);
    expect(groceries[0]!.description).toBe("Mine");
  });

  it("does not seed a second user's categories into the first user's list", async () => {
    await budget.ensureCategoriesSeeded({ userId });
    await budget.ensureCategoriesSeeded({ userId: "user-2" });
    expect(await repository.listCategoriesRaw(userId)).toHaveLength(BUDGET_CATEGORY_PRESETS.length);
    expect(await repository.listCategoriesRaw("user-2")).toHaveLength(BUDGET_CATEGORY_PRESETS.length);
  });
});

// The receipt job needs a full app: documentsService for real uploads on the local
// storage driver, jobsService for the pipeline it cancels, and a fake AI adapter behind
// the real aiService so generateStructuredFromImages still resolves the vision slot,
// checks capabilities, and validates the reply, exactly as it does in production. No
// test in this file ever reaches a real provider.
function fakeAdapter(replyRef: { current: unknown }): AiAdapter {
  return {
    generateStructured: vi.fn(async () => ({ data: {}, usage: { promptTokens: 0, completionTokens: 0 } })),
    generateStructuredFromImages: vi.fn(async () => ({ data: replyRef.current, usage: { promptTokens: 20, completionTokens: 20 } })),
    streamText: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    streamChat: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    embed: vi.fn(async () => ({ vectors: [], dimension: 0 })),
    recognizeImage: vi.fn(async () => ({ text: "" })),
    transcribeAudio: vi.fn(async () => ({ text: "" })),
    listModels: vi.fn(async () => []),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1, message: "ok" })),
  } as unknown as AiAdapter;
}

async function setupReceiptTest() {
  const replyRef = {
    current: {
      merchant: "Corner Shop",
      purchasedAt: "2026-09-10",
      currency: "USD",
      total: 5,
      category: "Groceries",
      categoryConfidence: 0.9,
      items: [{ description: "Bread", amount: 5, category: "Groceries", categoryConfidence: 0.9 }],
    } as unknown,
  };
  const adapter = fakeAdapter(replyRef);
  const t = await createTestApp({ adapterFactories: { "openai-compatible": () => adapter, "anthropic": () => adapter } });
  const { userId } = await t.signIn();
  await t.services.settingsService.set(userId, {
    "ai.openrouter.apiKey": "sk-or-v1-test",
    "ai.model.vision": "openrouter://google/gemini-2.5-flash",
  });
  const runner = createJobRunner({ db: t.db, handlers: { receipt: t.services.budgetService.handler } });
  return { t, userId, replyRef, adapter, runner };
}

// Content, not filename, decides document dedup (upload() reuses a row on a content
// hash match), so each page needs its own bytes or two "different" pages would collapse
// into one document.
let uploadCounter = 0;
async function uploadPage(t: Awaited<ReturnType<typeof setupReceiptTest>>["t"], userId: string, name = "page.jpg") {
  uploadCounter += 1;
  const { document } = await t.services.documentsService.upload({
    userId,
    name,
    mimeType: "image/jpeg",
    body: Readable.from([Buffer.from(`fake receipt bytes ${name} ${uploadCounter}`)]),
  });
  return document.id as string;
}

describe("budget service, createReceipt", () => {
  it("creates the receipt pending against page one and returns at once", async () => {
    const { t, userId } = await setupReceiptTest();
    const page1 = await uploadPage(t, userId);
    const { receipt, alreadyExisted } = await t.services.budgetService.createReceipt({ userId, documentIds: [page1] });
    expect(alreadyExisted).toBe(false);
    expect(receipt.status).toBe("pending");
    expect(receipt.documentId).toBe(page1);
  });

  it("hangs pages two and later off page one, the way a mail attachment hangs off its mail", async () => {
    const { t, userId } = await setupReceiptTest();
    const page1 = await uploadPage(t, userId, "page1.jpg");
    const page2 = await uploadPage(t, userId, "page2.jpg");
    await t.services.budgetService.createReceipt({ userId, documentIds: [page1, page2] });

    const child = await t.services.documentsService.get({ userId, documentId: page2 });
    expect(child.parentDocumentId).toBe(page1);
  });

  it("refuses an eleventh page", async () => {
    const { t, userId } = await setupReceiptTest();
    const ids: string[] = [];
    for (let i = 0; i < 11; i += 1) ids.push(await uploadPage(t, userId, `page${i}.jpg`));
    await expectAppError(() => t.services.budgetService.createReceipt({ userId, documentIds: ids }), "budget.too_many_pages");
  });

  it("returns the existing receipt instead of a duplicate row for a second receipt on the same page one", async () => {
    const { t, userId } = await setupReceiptTest();
    const page1 = await uploadPage(t, userId);
    const first = await t.services.budgetService.createReceipt({ userId, documentIds: [page1] });
    const second = await t.services.budgetService.createReceipt({ userId, documentIds: [page1] });
    expect(second.alreadyExisted).toBe(true);
    expect(second.receipt.id).toBe(first.receipt.id);
  });

  it("cancels pending rules and summarize for every page, page one included, but leaves page one's embedding running", async () => {
    const { t, userId } = await setupReceiptTest();
    const page1 = await uploadPage(t, userId, "page1.jpg");
    const page2 = await uploadPage(t, userId, "page2.jpg");
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId: page2, userId, mode: "initial" } });
    await t.services.jobsService.enqueue({ userId, type: "summarize", payload: { documentId: page2, userId } });
    await t.services.jobsService.enqueue({ userId, type: "embedding", payload: { documentId: page2, userId } });
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId: page1, userId, mode: "initial" } });
    await t.services.jobsService.enqueue({ userId, type: "summarize", payload: { documentId: page1, userId } });
    await t.services.jobsService.enqueue({ userId, type: "embedding", payload: { documentId: page1, userId } });

    await t.services.budgetService.createReceipt({ userId, documentIds: [page1, page2] });

    const jobs = await t.services.jobsService.list({ userId });
    const forDocument = (documentId: string) => jobs.filter((j) => (JSON.parse(j.payload) as { documentId?: string }).documentId === documentId);
    const cancelable = (documentId: string) => forDocument(documentId).filter((j) => j.type !== "extraction");
    expect(cancelable(page2)).toHaveLength(3);
    for (const job of cancelable(page2)) expect(job.status).toBe("done");
    // Extraction itself is never cancelled: local OCR runs on every page regardless.
    expect(forDocument(page2).find((j) => j.type === "extraction")!.status).toBe("pending");

    // Page one is filed by the receipt too, so no sorting or summary job is left
    // running for it either.
    expect(forDocument(page1).find((j) => j.type === "rules")!.status).toBe("done");
    expect(forDocument(page1).find((j) => j.type === "summarize")!.status).toBe("done");
    // Its embedding is the one job the cancellation leaves alone: chat and search still
    // need it to answer a question about what was bought.
    expect(forDocument(page1).find((j) => j.type === "embedding")!.status).toBe("pending");

    const page2Doc = await t.services.documentsService.get({ userId, documentId: page2 });
    expect(page2Doc.ruleStatus).toBe("done");
    expect(page2Doc.summaryStatus).toBe("done");
    expect(page2Doc.embeddingStatus).toBe("done");

    const page1Doc = await t.services.documentsService.get({ userId, documentId: page1 });
    expect(page1Doc.ruleStatus).toBe("done");
    expect(page1Doc.summaryStatus).toBe("done");
    expect(page1Doc.embeddingStatus).toBe("pending");
  });

  it("marks every page of a receipt, page one included, as owned by the budget module", async () => {
    const { t, userId } = await setupReceiptTest();
    const page1 = await uploadPage(t, userId, "page1.jpg");
    const page2 = await uploadPage(t, userId, "page2.jpg");

    await t.services.budgetService.createReceipt({ userId, documentIds: [page1, page2] });

    expect((await t.services.documentsService.get({ userId, documentId: page1 })).source).toBe("budget");
    expect((await t.services.documentsService.get({ userId, documentId: page2 })).source).toBe("budget");
  });
});

describe("budget service, receipt job", () => {
  it("reads a receipt from its photos in one AI call and stores the header and items", async () => {
    const { t, userId, runner, adapter } = await setupReceiptTest();
    const page1 = await uploadPage(t, userId, "page1.jpg");
    const page2 = await uploadPage(t, userId, "page2.jpg");
    const { receipt } = await t.services.budgetService.createReceipt({ userId, documentIds: [page1, page2] });

    expect(await runner.runOnce()).toBe(1);
    expect(adapter.generateStructuredFromImages).toHaveBeenCalledTimes(1);
    const call = (adapter.generateStructuredFromImages as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { images: unknown[] };
    expect(call.images).toHaveLength(2);

    const stored = await t.services.budgetService.getReceipt({ userId, receiptId: receipt.id });
    expect(stored.status).toBe("ready");
    expect(stored.merchant).toBe("Corner Shop");
    expect(stored.total).toBe(5);
    expect(stored.items).toHaveLength(1);
    expect(stored.items[0]!.description).toBe("Bread");
  });

  it("marks the receipt failed when the model returns nothing readable, using the warning as the note", async () => {
    const { t, userId, replyRef, runner } = await setupReceiptTest();
    replyRef.current = { merchant: null, purchasedAt: null, currency: null, total: null, warning: "Too blurry to read" };
    const page1 = await uploadPage(t, userId);
    const { receipt } = await t.services.budgetService.createReceipt({ userId, documentIds: [page1] });

    expect(await runner.runOnce()).toBe(1);
    const stored = await t.services.budgetService.getReceipt({ userId, receiptId: receipt.id });
    expect(stored.status).toBe("failed");
    expect(stored.note).toBe("Too blurry to read");
    expect(stored.items).toEqual([]);
  });

  // The user's own rule: "if date not found on receipt, just use the scan date then."
  // Without this, a receipt with no printed date belongs to no month and disappears from
  // the Budget page exactly like the wrong-year bug did, just from a blank field.
  it("falls back to the receipt's own creation date when the model reads no purchase date at all, and stays ready", async () => {
    const { t, userId, replyRef, runner } = await setupReceiptTest();
    replyRef.current = { merchant: "Corner Shop", purchasedAt: null, currency: "USD", total: 5, items: [{ description: "Bread", amount: 5 }] };
    const page1 = await uploadPage(t, userId);
    const { receipt } = await t.services.budgetService.createReceipt({ userId, documentIds: [page1] });

    expect(await runner.runOnce()).toBe(1);
    const stored = await t.services.budgetService.getReceipt({ userId, receiptId: receipt.id });
    expect(stored.status).toBe("ready");
    expect(stored.purchasedAt).toBe(receipt.createdAt.slice(0, 10));
    expect(stored.note).toBe("The receipt did not show a purchase date, so the date it was scanned was used instead.");
  });

  it("flags a new receipt as a duplicate of an earlier one with the same merchant, date, total and currency, and deletes neither", async () => {
    const { t, userId, runner } = await setupReceiptTest();
    const firstPage = await uploadPage(t, userId, "first.jpg");
    const { receipt: firstReceipt } = await t.services.budgetService.createReceipt({ userId, documentIds: [firstPage] });
    expect(await runner.runOnce()).toBe(1);

    const secondPage = await uploadPage(t, userId, "second.jpg");
    const { receipt: secondReceipt } = await t.services.budgetService.createReceipt({ userId, documentIds: [secondPage] });
    expect(await runner.runOnce()).toBe(1);

    const stored = await t.services.budgetService.getReceipt({ userId, receiptId: secondReceipt.id });
    expect(stored.duplicateOfReceiptId).toBe(firstReceipt.id);
    expect(stored.status).toBe("needs_review");

    expect(await t.services.budgetService.getReceipt({ userId, receiptId: firstReceipt.id })).toBeTruthy();
  });
});

describe("budget service, editing and resolving a receipt", () => {
  it("sets an item's category source to manual and keeps it there", async () => {
    const { t, userId, runner } = await setupReceiptTest();
    const page1 = await uploadPage(t, userId);
    const { receipt } = await t.services.budgetService.createReceipt({ userId, documentIds: [page1] });
    await runner.runOnce();
    // The job's own ensureCategoriesSeeded call already seeded the presets by now, so a
    // name from that list would collide; pick one that is not a preset.
    const category = await t.services.budgetService.createCategory({ userId, name: "Kids Activities" });
    const withItems = await t.services.budgetService.getReceipt({ userId, receiptId: receipt.id });
    const item = withItems.items[0]!;

    const updated = await t.services.budgetService.updateReceiptItemCategory({ userId, receiptId: receipt.id, itemId: item.id, categoryId: category.id });
    const updatedItem = updated.items.find((i) => i.id === item.id)!;
    expect(updatedItem.categoryId).toBe(category.id);
    expect(updatedItem.categorySource).toBe("manual");
  });

  it("resolves a duplicate by keeping both, clearing the flag", async () => {
    const { t, userId, runner } = await setupReceiptTest();
    const firstPage = await uploadPage(t, userId, "first.jpg");
    await t.services.budgetService.createReceipt({ userId, documentIds: [firstPage] });
    await runner.runOnce();
    const secondPage = await uploadPage(t, userId, "second.jpg");
    const { receipt: dup } = await t.services.budgetService.createReceipt({ userId, documentIds: [secondPage] });
    await runner.runOnce();

    const result = await t.services.budgetService.resolveDuplicate({ userId, receiptId: dup.id, action: "keep" });
    expect("receipt" in result && result.receipt.duplicateOfReceiptId).toBeNull();
    expect("receipt" in result && result.receipt.status).toBe("ready");
  });

  it("resolves a duplicate by deleting it, trashing its document (and any child page) rather than purging it", async () => {
    const { t, userId, runner } = await setupReceiptTest();
    const firstPage = await uploadPage(t, userId, "first.jpg");
    await t.services.budgetService.createReceipt({ userId, documentIds: [firstPage] });
    await runner.runOnce();
    const secondPage = await uploadPage(t, userId, "second.jpg");
    const secondPageTwo = await uploadPage(t, userId, "second-page2.jpg");
    const { receipt: dup } = await t.services.budgetService.createReceipt({ userId, documentIds: [secondPage, secondPageTwo] });
    await runner.runOnce();

    const result = await t.services.budgetService.resolveDuplicate({ userId, receiptId: dup.id, action: "delete" });
    expect(result).toEqual({ deleted: true });
    await expectAppError(() => t.services.budgetService.getReceipt({ userId, receiptId: dup.id }), "budget.receipt_not_found");
    await expectAppError(() => t.services.documentsService.get({ userId, documentId: secondPage }), "documents.not_found");
    await expectAppError(() => t.services.documentsService.get({ userId, documentId: secondPageTwo }), "documents.not_found");
  });
});

describe("budget service, listMonth", () => {
  it("returns the month's receipts with no nearest-month hint when this month has some", async () => {
    const { t, userId, runner } = await setupReceiptTest();
    const page1 = await uploadPage(t, userId);
    await t.services.budgetService.createReceipt({ userId, documentIds: [page1] });
    await runner.runOnce();

    const result = await t.services.budgetService.listMonth({ userId, month: "2026-09" });
    expect(result.receipts).toHaveLength(1);
    expect(result.nearestMonthWithReceipts).toBeNull();
  });

  // The real bug: a receipt reads fine but lands in a month the user never checks, and an
  // empty month gives no hint it exists anywhere. listMonth on the empty month must point
  // at the nearest month that actually has one.
  it("explains an empty month by pointing at the nearest month that has a receipt", async () => {
    const { t, userId, runner } = await setupReceiptTest();
    const page1 = await uploadPage(t, userId);
    await t.services.budgetService.createReceipt({ userId, documentIds: [page1] });
    await runner.runOnce(); // fixture reply's purchasedAt is 2026-09-10

    const result = await t.services.budgetService.listMonth({ userId, month: "2026-11" });
    expect(result.receipts).toEqual([]);
    expect(result.nearestMonthWithReceipts).toBe("2026-09");
  });

  it("gives no nearest-month hint when the user has no receipts anywhere", async () => {
    const { t, userId } = await setupReceiptTest();
    const result = await t.services.budgetService.listMonth({ userId, month: "2026-09" });
    expect(result.receipts).toEqual([]);
    expect(result.nearestMonthWithReceipts).toBeNull();
  });

  it("moves a receipt into a new month once its date is corrected, and out of the old one", async () => {
    const { t, userId, runner } = await setupReceiptTest();
    const page1 = await uploadPage(t, userId);
    const { receipt } = await t.services.budgetService.createReceipt({ userId, documentIds: [page1] });
    await runner.runOnce(); // fixture reply's purchasedAt is 2026-09-10

    const septemberBefore = await t.services.budgetService.listMonth({ userId, month: "2026-09" });
    expect(septemberBefore.receipts.map((r) => r.id)).toContain(receipt.id);

    await t.services.budgetService.updateReceiptFields({ userId, receiptId: receipt.id, patch: { purchasedAt: "2026-10-01" } });

    const septemberAfter = await t.services.budgetService.listMonth({ userId, month: "2026-09" });
    expect(septemberAfter.receipts.map((r) => r.id)).not.toContain(receipt.id);

    const october = await t.services.budgetService.listMonth({ userId, month: "2026-10" });
    expect(october.receipts.map((r) => r.id)).toContain(receipt.id);
  });
});

describe("budget service, category CRUD", () => {
  it("creates, updates, and deletes a category", async () => {
    const { t, userId } = await setupReceiptTest();
    const category = await t.services.budgetService.createCategory({ userId, name: "Household" });
    expect(category.autoApply).toBe(1);

    const updated = await t.services.budgetService.updateCategory({ userId, categoryId: category.id, patch: { color: "#00ff00" } });
    expect(updated.color).toBe("#00ff00");

    await t.services.budgetService.deleteCategory({ userId, categoryId: category.id });
    await expectAppError(() => t.services.budgetService.updateCategory({ userId, categoryId: category.id, patch: { color: "#000000" } }), "budget.category_not_found");
  });

  it("refuses a second category with the same name", async () => {
    const { t, userId } = await setupReceiptTest();
    await t.services.budgetService.createCategory({ userId, name: "Household" });
    await expectAppError(() => t.services.budgetService.createCategory({ userId, name: "household" }), "budget.category_duplicate_name");
  });
});
