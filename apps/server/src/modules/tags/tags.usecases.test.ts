import { beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import { newDocumentId, nowIso } from "../documents/documents.models.js";
import type { NewDocument } from "../documents/documents.types.js";
import { createTagsRepository } from "./tags.repository.js";
import { createTagsService } from "./tags.usecases.js";

const userId = "user-1";
let tags: ReturnType<typeof createTagsService>;
let tagsRepository: ReturnType<typeof createTagsRepository>;
let documents: ReturnType<typeof createDocumentsRepository>;

beforeEach(async () => {
  const { db } = await createTestDatabase();
  tags = createTagsService({ db });
  tagsRepository = createTagsRepository({ db });
  documents = createDocumentsRepository({ db });
});

function documentFixture(overrides: Partial<NewDocument> = {}): NewDocument {
  const t = nowIso();
  return {
    id: newDocumentId(),
    userId,
    name: "doc.txt",
    mimeType: "text/plain",
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

describe("tags service", () => {
  it("creates, lists alphabetically, updates, and deletes a tag", async () => {
    await tags.createTag({ userId, name: "Rent" });
    await tags.createTag({ userId, name: "apartment" });
    const list = await tags.listTags(userId);
    expect(list.map((t) => t.name)).toEqual(["apartment", "Rent"]);
    expect(list[0]).toMatchObject({ documentCount: 0, autoApply: true, confidenceThreshold: 0.7, description: "" });

    const rent = list.find((t) => t.name === "Rent")!;
    const updated = await tags.updateTag({ userId, tagId: rent.id, patch: { color: "#ff0000", description: "Monthly rent" } });
    expect(updated).toMatchObject({ color: "#ff0000", description: "Monthly rent" });

    await tags.deleteTag({ userId, tagId: rent.id });
    expect((await tags.listTags(userId)).map((t) => t.id)).not.toContain(rent.id);
  });

  it("rejects a sibling tag name that differs only by case", async () => {
    await tags.createTag({ userId, name: "Rent" });
    await expectAppError(() => tags.createTag({ userId, name: "rent" }), "tags.duplicate_name");
    await expectAppError(() => tags.createTag({ userId, name: "RENT" }), "tags.duplicate_name");
  });

  it("scopes tags by user and 404s on a missing or foreign tag", async () => {
    const tag = await tags.createTag({ userId, name: "Rent" });
    await expectAppError(() => tags.updateTag({ userId: "someone-else", tagId: tag.id, patch: { name: "x" } }), "tags.not_found");
    await expectAppError(() => tags.deleteTag({ userId, tagId: "tag_0000000000000000" }), "tags.not_found");
  });

  it("creates nested categories, lists with paths and sort order, updates, and deletes", async () => {
    const finance = await tags.createCategory({ userId, name: "Finance" });
    const tax = await tags.createCategory({ userId, name: "Tax", parentId: finance.id });
    const list = await tags.listCategories(userId);
    expect(list.find((c) => c.id === tax.id)).toMatchObject({ path: "Finance / Tax", parentId: finance.id, documentCount: 0 });

    const renamed = await tags.updateCategory({ userId, categoryId: tax.id, patch: { name: "Taxes" } });
    expect(renamed.name).toBe("Taxes");

    await tags.deleteCategory({ userId, categoryId: tax.id });
    expect((await tags.listCategories(userId)).map((c) => c.id)).not.toContain(tax.id);
  });

  it("assigns the next sort order to new siblings and orders by sortOrder then name", async () => {
    const a = await tags.createCategory({ userId, name: "zzz" });
    const b = await tags.createCategory({ userId, name: "aaa" });
    expect(a.sortOrder).toBe(0);
    expect(b.sortOrder).toBe(1);
    const list = await tags.listCategories(userId);
    expect(list.map((c) => c.name)).toEqual(["zzz", "aaa"]);
  });

  it("reorders siblings by patching sortOrder directly", async () => {
    const a = await tags.createCategory({ userId, name: "zzz" });
    const b = await tags.createCategory({ userId, name: "aaa" });
    // Swap so "zzz" (created first, sortOrder 0) sorts after "aaa" despite the name order.
    await tags.updateCategory({ userId, categoryId: a.id, patch: { sortOrder: 1 } });
    await tags.updateCategory({ userId, categoryId: b.id, patch: { sortOrder: 0 } });
    const list = await tags.listCategories(userId);
    expect(list.map((c) => c.id)).toEqual([b.id, a.id]);
  });

  it("rejects a sibling category name that differs only by case, but allows the same name under a different parent", async () => {
    const finance = await tags.createCategory({ userId, name: "Finance" });
    await tags.createCategory({ userId, name: "Receipts", parentId: finance.id });
    await expectAppError(() => tags.createCategory({ userId, name: "receipts", parentId: finance.id }), "categories.duplicate_name");
    await expect(tags.createCategory({ userId, name: "Receipts" })).resolves.toMatchObject({ name: "Receipts", parentId: null });
  });

  it("rejects a duplicate root category name that differs only by case", async () => {
    // Regression coverage for a real gap found during planning: SQLite treats every
    // NULL as distinct in a UNIQUE index, so two root categories (parent_id null)
    // are not caught by the (user_id, parent_id, name) index alone. The partial
    // root-only unique index must catch this.
    await tags.createCategory({ userId, name: "Finance" });
    await expectAppError(() => tags.createCategory({ userId, name: "finance" }), "categories.duplicate_name");
  });

  it("rejects self-parenting and cycles when moving a category", async () => {
    const a = await tags.createCategory({ userId, name: "A" });
    const b = await tags.createCategory({ userId, name: "B", parentId: a.id });
    const c = await tags.createCategory({ userId, name: "C", parentId: b.id });
    await expectAppError(() => tags.updateCategory({ userId, categoryId: a.id, patch: { parentId: a.id } }), "categories.invalid_parent");
    await expectAppError(() => tags.updateCategory({ userId, categoryId: a.id, patch: { parentId: c.id } }), "categories.invalid_parent");
    await expectAppError(() => tags.updateCategory({ userId, categoryId: a.id, patch: { parentId: "cat_0000000000000000" } }), "categories.invalid_parent");
    const moved = await tags.updateCategory({ userId, categoryId: c.id, patch: { parentId: a.id } });
    expect(moved.parentId).toBe(a.id);
  });

  it("deleting a category moves its children up to its parent and clears it from every document, manual or automatic", async () => {
    const finance = await tags.createCategory({ userId, name: "Finance" });
    const tax = await tags.createCategory({ userId, name: "Tax", parentId: finance.id });
    const receipts = await tags.createCategory({ userId, name: "Receipts", parentId: tax.id });
    const manualDoc = documentFixture({ categoryId: tax.id, categorySource: "manual" });
    const autoDoc = documentFixture({ categoryId: tax.id, categorySource: "auto" });
    await documents.insert(manualDoc);
    await documents.insert(autoDoc);

    await tags.deleteCategory({ userId, categoryId: tax.id });

    const list = await tags.listCategories(userId);
    expect(list.find((c) => c.id === receipts.id)?.parentId).toBe(finance.id);
    expect(await documents.findById({ userId, documentId: manualDoc.id! as string })).toMatchObject({ categoryId: null, categorySource: null });
    expect(await documents.findById({ userId, documentId: autoDoc.id! as string })).toMatchObject({ categoryId: null, categorySource: null });
  });

  it("deleting a root category moves its children to the root", async () => {
    const finance = await tags.createCategory({ userId, name: "Finance" });
    const tax = await tags.createCategory({ userId, name: "Tax", parentId: finance.id });
    await tags.deleteCategory({ userId, categoryId: finance.id });
    expect((await tags.listCategories(userId)).find((c) => c.id === tax.id)?.parentId).toBeNull();
  });

  it("turning autoApply off on a category clears only the auto-sourced documents", async () => {
    const category = await tags.createCategory({ userId, name: "Finance" });
    const manualDoc = documentFixture({ categoryId: category.id, categorySource: "manual" });
    const autoDoc = documentFixture({ categoryId: category.id, categorySource: "auto" });
    await documents.insert(manualDoc);
    await documents.insert(autoDoc);

    await tags.updateCategory({ userId, categoryId: category.id, patch: { autoApply: false } });

    expect(await documents.findById({ userId, documentId: manualDoc.id! as string })).toMatchObject({ categoryId: category.id, categorySource: "manual" });
    expect(await documents.findById({ userId, documentId: autoDoc.id! as string })).toMatchObject({ categoryId: null, categorySource: null });
  });

  it("counts documents linked to a tag and removes the link (by cascade) when the tag is deleted", async () => {
    const tag = await tags.createTag({ userId, name: "Rent" });
    const doc = documentFixture();
    await documents.insert(doc);
    await tags.setDocumentTag({ userId, documentId: doc.id! as string, tagId: tag.id });
    expect((await tags.listTags(userId)).find((t) => t.id === tag.id)?.documentCount).toBe(1);

    await tags.deleteTag({ userId, tagId: tag.id });
    expect(await tagsRepository.listTagsForDocument(doc.id! as string)).toEqual([]);
  });

  it("deleting a document cascades to its document_tags rows", async () => {
    // Regression coverage for review finding B1: without ON DELETE CASCADE, deleting a
    // document would leave an orphan document_tags row inflating the tag's count.
    const tag = await tags.createTag({ userId, name: "Rent" });
    const doc = documentFixture();
    await documents.insert(doc);
    await tags.setDocumentTag({ userId, documentId: doc.id, tagId: tag.id });
    expect((await tags.listTags(userId)).find((t) => t.id === tag.id)?.documentCount).toBe(1);

    await documents.remove({ userId, documentId: doc.id });

    expect(await tagsRepository.listTagsForDocument(doc.id)).toEqual([]);
    expect((await tags.listTags(userId)).find((t) => t.id === tag.id)?.documentCount).toBe(0);
  });

  it("sets and clears a document's manual category, rejecting an unknown category", async () => {
    const doc = documentFixture();
    await documents.insert(doc);
    const category = await tags.createCategory({ userId, name: "Finance" });

    const withCategory = await tags.setDocumentCategory({ userId, documentId: doc.id! as string, categoryId: category.id });
    expect(withCategory).toMatchObject({ categoryId: category.id, categorySource: "manual" });

    const cleared = await tags.setDocumentCategory({ userId, documentId: doc.id! as string, categoryId: null });
    expect(cleared).toMatchObject({ categoryId: null, categorySource: null });

    await expectAppError(
      () => tags.setDocumentCategory({ userId, documentId: doc.id! as string, categoryId: "cat_0000000000000000" }),
      "categories.not_found",
    );
    await expectAppError(
      () => tags.setDocumentCategory({ userId, documentId: "doc_0000000000000000", categoryId: null }),
      "documents.not_found",
    );
  });

  it("sets and clears a document's manual tag, deleting the link only when nothing else applies it", async () => {
    const doc = documentFixture();
    await documents.insert(doc);
    const tag = await tags.createTag({ userId, name: "Rent" });

    const withTag = await tags.setDocumentTag({ userId, documentId: doc.id! as string, tagId: tag.id });
    expect(withTag).toEqual([{ id: tag.id, name: "Rent", color: null, auto: false, manual: true }]);

    const cleared = await tags.clearDocumentTag({ userId, documentId: doc.id! as string, tagId: tag.id });
    expect(cleared).toEqual([]);

    await expectAppError(() => tags.setDocumentTag({ userId, documentId: doc.id! as string, tagId: "tag_0000000000000000" }), "tags.not_found");
  });
});
