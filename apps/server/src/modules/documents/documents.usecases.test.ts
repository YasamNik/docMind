import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import { createSettingsRegistry } from "../settings/settings.registry.js";
import { createSettingsService } from "../settings/settings.usecases.js";
import { storageSettingDefinitions } from "../storage/storage.settings.js";
import { createStorageService } from "../storage/storage.usecases.js";
import { createTagsService } from "../tags/tags.usecases.js";
import { createDocumentsRepository } from "./documents.repository.js";
import { createDocumentsService } from "./documents.usecases.js";

let root: string;
let documents: ReturnType<typeof createDocumentsService>;
let storageService: ReturnType<typeof createStorageService>;
let db: Awaited<ReturnType<typeof createTestDatabase>>["db"];
const userId = "user-1";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docmind-docs-"));
  ({ db } = await createTestDatabase());
  const settingsService = createSettingsService({
    db,
    registry: createSettingsRegistry(storageSettingDefinitions),
    config: { settingsEncryptionKey: "22".repeat(32), env: { DOCUMENT_STORAGE_ROOT: root } },
  });
  storageService = createStorageService({ settingsService });
  documents = createDocumentsService({ db, storageService });
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function readAll(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString();
}

describe("documents service", () => {
  it("uploads, stores, and reads back a file", async () => {
    const { document, duplicateOf } = await documents.upload({ userId, name: "notes.txt", mimeType: "text/plain", body: Readable.from(["hello"]) });
    expect(duplicateOf).toBeUndefined();
    expect(document).toMatchObject({ name: "notes.txt", mimeType: "text/plain", sizeBytes: 5, storageDriver: "local", extractionStatus: "pending" });
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    expect(document.storageKey).toBe(`${userId}/${yyyy}/${mm}/${document.id}/notes.txt`);
    const { stream } = await documents.openFile({ userId, documentId: document.id });
    expect(await readAll(stream)).toBe("hello");
  });

  it("still serves a file whose storage key uses the pre-C2 layout", async () => {
    const driver = await storageService.getDriver(userId, "local");
    const oldKey = `${userId}/doc_legacy00000000/old.txt`;
    await driver.put({ key: oldKey, body: Readable.from(["legacy content"]) });

    const repository = createDocumentsRepository({ db });
    const t = new Date().toISOString();
    await repository.insert({
      id: "doc_legacy00000000",
      userId,
      name: "old.txt",
      mimeType: "text/plain",
      sizeBytes: 14,
      contentHash: "legacyhash",
      storageDriver: "local",
      storageKey: oldKey,
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
    });

    const { stream } = await documents.openFile({ userId, documentId: "doc_legacy00000000" });
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe("legacy content");
  });

  it("detects duplicates by content hash and keeps one file", async () => {
    const first = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["same"]) });
    const second = await documents.upload({ userId, name: "b.txt", mimeType: "text/plain", body: Readable.from(["same"]) });
    expect(second.duplicateOf).toBe(first.document.id);
    expect(second.document.id).toBe(first.document.id);
    expect((await documents.list({ userId })).length).toBe(1);
  });

  it("lists newest first, renames, and removes with the file", async () => {
    const a = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const b = await documents.upload({ userId, name: "b.txt", mimeType: "text/plain", body: Readable.from(["b"]) });
    expect((await documents.list({ userId })).map((d) => d.id)).toEqual([b.document.id, a.document.id]);
    await documents.rename({ userId, documentId: a.document.id, name: "renamed.txt" });
    expect((await documents.get({ userId, documentId: a.document.id })).name).toBe("renamed.txt");
    await documents.remove({ userId, documentId: a.document.id });
    await expectAppError(() => documents.get({ userId, documentId: a.document.id }), "documents.not_found");
  });

  it("scopes everything by user", async () => {
    const { document } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    await expectAppError(() => documents.get({ userId: "someone-else", documentId: document.id }), "documents.not_found");
    expect(await documents.list({ userId: "someone-else" })).toEqual([]);
  });

  it("rejects and cleans up a file that exceeds the upload limit after streaming", async () => {
    const body = Readable.from(["x".repeat(32)]);
    await expectAppError(
      () => documents.upload({ userId, name: "big.txt", mimeType: "text/plain", body, maxUploadBytes: 16 }),
      "documents.too_large",
    );
    expect(await documents.list({ userId })).toEqual([]);
    const filesInRoot = await readdir(root, { recursive: true });
    expect(filesInRoot.some((entry) => entry.includes("big.txt"))).toBe(false);
  });
});

describe("documents service filters and enrichment", () => {
  it("filters by view: inbox is unstarted rule status, needs_review is done with no category", async () => {
    const { document: pending } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const { document: done } = await documents.upload({ userId, name: "b.txt", mimeType: "text/plain", body: Readable.from(["b"]) });
    const repository = createDocumentsRepository({ db });
    await repository.update({ userId, documentId: done.id, patch: { ruleStatus: "done" } });

    const inbox = await documents.list({ userId, view: "inbox" });
    expect(inbox.map((d) => d.id)).toEqual([pending.id]);

    const needsReview = await documents.list({ userId, view: "needs_review" });
    expect(needsReview.map((d) => d.id)).toEqual([done.id]);

    await repository.update({ userId, documentId: done.id, patch: { categoryId: "cat_0000000000000001", categorySource: "manual" } });
    expect((await documents.list({ userId, view: "needs_review" })).map((d) => d.id)).toEqual([]);
  });

  it("filters by categoryId including descendants, and by tagId", async () => {
    const tags = createTagsService({ db });
    const finance = await tags.createCategory({ userId, name: "Finance" });
    const tax = await tags.createCategory({ userId, name: "Tax", parentId: finance.id });
    const tag = await tags.createTag({ userId, name: "Rent" });

    const { document: inTax } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const { document: inFinance } = await documents.upload({ userId, name: "b.txt", mimeType: "text/plain", body: Readable.from(["b"]) });
    const { document: elsewhere } = await documents.upload({ userId, name: "c.txt", mimeType: "text/plain", body: Readable.from(["c"]) });
    await tags.setDocumentCategory({ userId, documentId: inTax.id, categoryId: tax.id });
    await tags.setDocumentCategory({ userId, documentId: inFinance.id, categoryId: finance.id });
    await tags.setDocumentTag({ userId, documentId: elsewhere.id, tagId: tag.id });

    const byFinance = await documents.list({ userId, categoryId: finance.id });
    expect(byFinance.map((d) => d.id).sort()).toEqual([inFinance.id, inTax.id].sort());
    expect(byFinance.find((d) => d.id === inTax.id)?.categoryPath).toBe("Finance / Tax");

    const byTag = await documents.list({ userId, tagId: tag.id });
    expect(byTag.map((d) => d.id)).toEqual([elsewhere.id]);
    expect(byTag[0]?.tags).toEqual([{ id: tag.id, name: "Rent", color: null, auto: false, manual: true }]);
  });

  it("combines categoryId and tagId filters with AND", async () => {
    const tags = createTagsService({ db });
    const category = await tags.createCategory({ userId, name: "Finance" });
    const tag = await tags.createTag({ userId, name: "Rent" });
    const { document: both } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const { document: onlyCategory } = await documents.upload({ userId, name: "b.txt", mimeType: "text/plain", body: Readable.from(["b"]) });
    await tags.setDocumentCategory({ userId, documentId: both.id, categoryId: category.id });
    await tags.setDocumentTag({ userId, documentId: both.id, tagId: tag.id });
    await tags.setDocumentCategory({ userId, documentId: onlyCategory.id, categoryId: category.id });

    const result = await documents.list({ userId, categoryId: category.id, tagId: tag.id });
    expect(result.map((d) => d.id)).toEqual([both.id]);
  });

  it("get() returns the category path and tag chips for a single document", async () => {
    const tags = createTagsService({ db });
    const category = await tags.createCategory({ userId, name: "Finance" });
    const { document } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    await tags.setDocumentCategory({ userId, documentId: document.id, categoryId: category.id });
    const detail = await documents.get({ userId, documentId: document.id });
    expect(detail).toMatchObject({ categoryId: category.id, categoryPath: "Finance", tags: [] });
  });
});
