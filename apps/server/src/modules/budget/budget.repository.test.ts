import { beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import type { Database } from "../database/database.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import { newDocumentId, nowIso as documentNowIso } from "../documents/documents.models.js";
import type { NewDocument } from "../documents/documents.types.js";
import { newBudgetCategoryId, newBudgetReceiptId, newBudgetReceiptItemId, nowIso } from "./budget.models.js";
import { createBudgetRepository } from "./budget.repository.js";
import type { NewBudgetCategory, NewBudgetReceipt, NewBudgetReceiptItem } from "./budget.types.js";

const userId = "user-1";
let db: Database;
let repository: ReturnType<typeof createBudgetRepository>;
let documents: ReturnType<typeof createDocumentsRepository>;

beforeEach(async () => {
  ({ db } = await createTestDatabase());
  repository = createBudgetRepository({ db });
  documents = createDocumentsRepository({ db });
});

function documentFixture(overrides: Partial<NewDocument> = {}): NewDocument {
  const t = documentNowIso();
  return {
    id: newDocumentId(),
    userId,
    name: "receipt.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 10,
    contentHash: null,
    storageDriver: "local",
    storageKey: "key",
    extractedText: null,
    extractionStatus: "done",
    extractionError: null,
    ruleStatus: "done",
    ruleError: null,
    embeddingStatus: "pending",
    embeddingError: null,
    categoryId: null,
    categorySource: null,
    createdAt: t,
    updatedAt: t,
    ...overrides,
  };
}

async function receiptFixture(overrides: Partial<NewBudgetReceipt> = {}): Promise<NewBudgetReceipt> {
  const documentId = overrides.documentId ?? (await (async () => {
    const doc = documentFixture();
    await documents.insert(doc);
    return doc.id as string;
  })());
  const t = nowIso();
  return {
    id: newBudgetReceiptId(),
    userId,
    documentId,
    merchant: "Corner Shop",
    categoryId: null,
    purchasedAt: "2026-09-10",
    currency: "USD",
    total: 12.5,
    taxAmount: null,
    status: "pending",
    note: null,
    duplicateOfReceiptId: null,
    createdAt: t,
    updatedAt: t,
    ...overrides,
  };
}

function itemFixture(receiptId: string, overrides: Partial<NewBudgetReceiptItem> = {}): NewBudgetReceiptItem {
  const t = nowIso();
  return {
    id: newBudgetReceiptItemId(),
    userId,
    receiptId,
    lineNumber: 1,
    description: "Bread",
    quantity: 1,
    unitPrice: 2.5,
    amount: 2.5,
    categoryId: null,
    categorySource: null,
    confidence: null,
    createdAt: t,
    updatedAt: t,
    ...overrides,
  };
}

function categoryFixture(overrides: Partial<NewBudgetCategory> = {}): NewBudgetCategory {
  const t = nowIso();
  return {
    id: newBudgetCategoryId(),
    userId,
    name: "Groceries",
    description: "Everyday food and drink.",
    color: null,
    autoApply: 1,
    createdAt: t,
    updatedAt: t,
    ...overrides,
  };
}

describe("budget repository", () => {
  it("creates a receipt with its items in one transaction and reads them back together", async () => {
    const receipt = await receiptFixture();
    const items = [itemFixture(receipt.id as string, { lineNumber: 2, description: "Milk" }), itemFixture(receipt.id as string, { lineNumber: 1, description: "Bread" })];
    await repository.insertReceiptWithItems({ receipt, items });

    const found = await repository.findReceiptWithItems({ userId, receiptId: receipt.id as string });
    expect(found).not.toBeNull();
    expect(found!.merchant).toBe("Corner Shop");
    expect(found!.items.map((i) => i.description)).toEqual(["Bread", "Milk"]);
  });

  it("returns null reading a receipt that does not exist or belongs to another user", async () => {
    const receipt = await receiptFixture();
    await repository.insertReceiptWithItems({ receipt, items: [] });
    expect(await repository.findReceiptWithItems({ userId: "someone-else", receiptId: receipt.id as string })).toBeNull();
    expect(await repository.findReceiptWithItems({ userId, receiptId: "brcpt_0000000000000000" })).toBeNull();
  });

  it("lists a month's receipts with items, newest first, scoped to that month", async () => {
    const inMonth1 = await receiptFixture({ purchasedAt: "2026-09-05" });
    const inMonth2 = await receiptFixture({ purchasedAt: "2026-09-20" });
    const otherMonth = await receiptFixture({ purchasedAt: "2026-08-20" });
    await repository.insertReceiptWithItems({ receipt: inMonth1, items: [itemFixture(inMonth1.id as string)] });
    await repository.insertReceiptWithItems({ receipt: inMonth2, items: [itemFixture(inMonth2.id as string)] });
    await repository.insertReceiptWithItems({ receipt: otherMonth, items: [itemFixture(otherMonth.id as string)] });

    const list = await repository.listMonthReceiptsWithItems({ userId, month: "2026-09" });
    expect(list.map((r) => r.id)).toEqual([inMonth2.id, inMonth1.id]);
    expect(list[0]!.items).toHaveLength(1);
  });

  describe("findDuplicate", () => {
    it("matches merchant case insensitively and trimmed, plus date, total and currency", async () => {
      const original = await receiptFixture({ merchant: "Corner Shop", purchasedAt: "2026-09-10", total: 12.5, currency: "USD" });
      await repository.insertReceiptWithItems({ receipt: original, items: [] });

      const match = await repository.findDuplicate({ userId, merchant: "  corner shop  ", purchasedAt: "2026-09-10", total: 12.5, currency: "USD" });
      expect(match?.id).toBe(original.id);
    });

    it("does not match when the total, date, or currency differs", async () => {
      const original = await receiptFixture({ merchant: "Corner Shop", purchasedAt: "2026-09-10", total: 12.5, currency: "USD" });
      await repository.insertReceiptWithItems({ receipt: original, items: [] });

      expect(await repository.findDuplicate({ userId, merchant: "Corner Shop", purchasedAt: "2026-09-10", total: 9.99, currency: "USD" })).toBeNull();
      expect(await repository.findDuplicate({ userId, merchant: "Corner Shop", purchasedAt: "2026-09-11", total: 12.5, currency: "USD" })).toBeNull();
      expect(await repository.findDuplicate({ userId, merchant: "Corner Shop", purchasedAt: "2026-09-10", total: 12.5, currency: "EUR" })).toBeNull();
    });

    it("excludes the given receipt id, so a re-read does not flag itself", async () => {
      const original = await receiptFixture({ merchant: "Corner Shop", purchasedAt: "2026-09-10", total: 12.5, currency: "USD" });
      await repository.insertReceiptWithItems({ receipt: original, items: [] });

      const match = await repository.findDuplicate({
        userId,
        merchant: "Corner Shop",
        purchasedAt: "2026-09-10",
        total: 12.5,
        currency: "USD",
        excludeReceiptId: original.id as string,
      });
      expect(match).toBeNull();
    });
  });

  describe("category CRUD", () => {
    it("creates, finds, lists, updates, and deletes a category", async () => {
      const category = categoryFixture();
      await repository.insertCategory(category);

      expect(await repository.findCategoryById({ userId, categoryId: category.id as string })).toMatchObject({ name: "Groceries" });
      expect(await repository.listCategoriesRaw(userId)).toHaveLength(1);

      await repository.updateCategory({ userId, categoryId: category.id as string, patch: { color: "#00ff00" } });
      expect(await repository.findCategoryById({ userId, categoryId: category.id as string })).toMatchObject({ color: "#00ff00" });

      await repository.deleteCategory({ userId, categoryId: category.id as string });
      expect(await repository.findCategoryById({ userId, categoryId: category.id as string })).toBeNull();
    });
  });

  describe("foreign key behaviour", () => {
    it("deletes a receipt and its items when the underlying document is deleted", async () => {
      const receipt = await receiptFixture();
      await repository.insertReceiptWithItems({ receipt, items: [itemFixture(receipt.id as string)] });

      await documents.remove({ userId, documentId: receipt.documentId as string });

      expect(await repository.findReceiptWithItems({ userId, receiptId: receipt.id as string })).toBeNull();
    });

    it("sets category_id to null on the receipt and its items when the category is deleted", async () => {
      const category = categoryFixture();
      await repository.insertCategory(category);
      const receipt = await receiptFixture({ categoryId: category.id as string });
      await repository.insertReceiptWithItems({ receipt, items: [itemFixture(receipt.id as string, { categoryId: category.id as string })] });

      await repository.deleteCategory({ userId, categoryId: category.id as string });

      const found = await repository.findReceiptWithItems({ userId, receiptId: receipt.id as string });
      expect(found!.categoryId).toBeNull();
      expect(found!.items[0]!.categoryId).toBeNull();
    });
  });
});
