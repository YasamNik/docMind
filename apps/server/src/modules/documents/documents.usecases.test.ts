import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import { createTestTagsService } from "../../shared/test/tags-service.test-utils.js";
import { createSettingsRegistry } from "../settings/settings.registry.js";
import { createSettingsService } from "../settings/settings.usecases.js";
import { storageSettingDefinitions } from "../storage/storage.settings.js";
import { createStorageService } from "../storage/storage.usecases.js";
import { createFieldsRepository } from "../fields/fields.repository.js";
import { createDocumentsRepository } from "./documents.repository.js";
import { createDocumentsService } from "./documents.usecases.js";
import type { NewDocument } from "./documents.types.js";

let root: string;
let documents: ReturnType<typeof createDocumentsService>;
let storageService: ReturnType<typeof createStorageService>;
let settingsService: ReturnType<typeof createSettingsService>;
let db: Awaited<ReturnType<typeof createTestDatabase>>["db"];
const userId = "user-1";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docmind-docs-"));
  ({ db } = await createTestDatabase());
  settingsService = createSettingsService({
    db,
    registry: createSettingsRegistry(storageSettingDefinitions),
    config: { settingsEncryptionKey: "22".repeat(32), env: { DOCUMENT_STORAGE_ROOT: root } },
  });
  storageService = createStorageService({ settingsService, countDocuments: async () => 0 });
  documents = createDocumentsService({ db, storageService });
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function readAll(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString();
}

// Counts files only, not the directories the local driver's own put() leaves behind
// on disk even after delete() removes the file inside them.
async function countFiles(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    count += entry.isDirectory() ? await countFiles(full) : 1;
  }
  return count;
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
      triageStatus: "reviewed",
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

  it("records where a document came from, defaulting to an upload", async () => {
    const { document: browser } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const { document: bot } = await documents.upload({ userId, name: "b.txt", mimeType: "text/plain", body: Readable.from(["b"]), source: "telegram" });

    expect((await documents.get({ userId, documentId: browser.id })).source).toBe("upload");
    expect((await documents.get({ userId, documentId: bot.id })).source).toBe("telegram");
  });

  it("links an attachment to the mail it arrived in, and deletes it with the mail", async () => {
    const { document: mail } = await documents.upload({ userId, name: "mail.txt", mimeType: "text/plain", body: Readable.from(["body"]), source: "email" });
    const { document: attachment } = await documents.upload({
      userId, name: "invoice.pdf", mimeType: "application/pdf", body: Readable.from(["pdf"]),
      source: "email", parentDocumentId: mail.id,
    });

    expect((await documents.get({ userId, documentId: attachment.id })).parentDocumentId).toBe(mail.id);

    await documents.purge({ userId, documentId: mail.id });
    await expect(documents.get({ userId, documentId: attachment.id })).rejects.toMatchObject({ code: "documents.not_found" });
  });

  it("a hash match with a matching parent reuses the row and leaves no orphaned storage object", async () => {
    const { document: mail } = await documents.upload({ userId, name: "mail.txt", mimeType: "text/plain", body: Readable.from(["body"]), source: "email" });
    const first = await documents.upload({
      userId, name: "invoice.pdf", mimeType: "application/pdf", body: Readable.from(["same bytes"]),
      source: "email", parentDocumentId: mail.id,
    });
    const filesAfterFirst = await countFiles(root);

    // Same mail retried: the existing row's parentDocumentId already matches this call's.
    const retry = await documents.upload({
      userId, name: "invoice.pdf", mimeType: "application/pdf", body: Readable.from(["same bytes"]),
      source: "email", parentDocumentId: mail.id,
    });

    expect(retry.document.id).toBe(first.document.id);
    expect(retry.duplicateOf).toBe(first.document.id);
    const filesAfterRetry = await countFiles(root);
    expect(filesAfterRetry).toBe(filesAfterFirst);
  });

  it("a hash match with a differing parent creates a second row with its own storage key", async () => {
    const { document: mail1 } = await documents.upload({ userId, name: "mail1.txt", mimeType: "text/plain", body: Readable.from(["body1"]), source: "email" });
    const { document: mail2 } = await documents.upload({ userId, name: "mail2.txt", mimeType: "text/plain", body: Readable.from(["body2"]), source: "email" });

    const first = await documents.upload({
      userId, name: "invoice.pdf", mimeType: "application/pdf", body: Readable.from(["shared bytes"]),
      source: "email", parentDocumentId: mail1.id,
    });
    const second = await documents.upload({
      userId, name: "invoice.pdf", mimeType: "application/pdf", body: Readable.from(["shared bytes"]),
      source: "email", parentDocumentId: mail2.id,
    });

    expect(second.document.id).not.toBe(first.document.id);
    expect(second.duplicateOf).toBeUndefined();
    expect(second.document.storageKey).not.toBe(first.document.storageKey);
    expect(second.document.contentHash).toBe(first.document.contentHash);
    expect(second.document.parentDocumentId).toBe(mail2.id);

    // The original row is untouched: still linked to its own mail, not re-parented.
    const stillFirst = await documents.get({ userId, documentId: first.document.id });
    expect(stillFirst.parentDocumentId).toBe(mail1.id);

    // Both storage keys have live bytes behind them.
    const { stream: firstStream } = await documents.openFile({ userId, documentId: first.document.id });
    expect(await readAll(firstStream)).toBe("shared bytes");
    const { stream: secondStream } = await documents.openFile({ userId, documentId: second.document.id });
    expect(await readAll(secondStream)).toBe("shared bytes");
  });

  it("a hash match against a trashed row never reuses it and does not throw", async () => {
    const { document: original } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["trashed content"]) });
    await documents.remove({ userId, documentId: original.id });

    const second = await documents.upload({ userId, name: "b.txt", mimeType: "text/plain", body: Readable.from(["trashed content"]) });

    expect(second.document.id).not.toBe(original.id);
    expect(second.duplicateOf).toBeUndefined();

    const repository = createDocumentsRepository({ db });
    const stillTrashed = await repository.findById({ userId, documentId: original.id });
    expect(stillTrashed?.deletedAt).not.toBeNull();
    expect((await documents.get({ userId, documentId: second.document.id })).name).toBe("b.txt");
  });

  it("cascades at the database level too, when a parent row is deleted directly rather than through purge()", async () => {
    const { document: mail } = await documents.upload({ userId, name: "mail.txt", mimeType: "text/plain", body: Readable.from(["body"]), source: "email" });
    const { document: attachment } = await documents.upload({
      userId, name: "invoice.pdf", mimeType: "application/pdf", body: Readable.from(["pdf"]),
      source: "email", parentDocumentId: mail.id,
    });

    // Bypasses documents.purge()'s explicit child cleanup on purpose, so this exercises
    // the schema's own ON DELETE CASCADE rather than the application-level defense.
    const repository = createDocumentsRepository({ db });
    await repository.remove({ userId, documentId: mail.id });

    await expect(documents.get({ userId, documentId: attachment.id })).rejects.toMatchObject({ code: "documents.not_found" });
  });
});

describe("documents service trash and purge cascade", () => {
  async function uploadMailAndAttachment() {
    const { document: mail } = await documents.upload({ userId, name: "mail.txt", mimeType: "text/plain", body: Readable.from(["body"]), source: "email" });
    const { document: attachment } = await documents.upload({
      userId, name: "invoice.pdf", mimeType: "application/pdf", body: Readable.from(["pdf"]),
      source: "email", parentDocumentId: mail.id,
    });
    return { mail, attachment };
  }

  it("trashes a mail's attachment along with it", async () => {
    const { mail, attachment } = await uploadMailAndAttachment();

    await documents.remove({ userId, documentId: mail.id });

    const repository = createDocumentsRepository({ db });
    expect((await repository.findById({ userId, documentId: mail.id }))?.deletedAt).not.toBeNull();
    expect((await repository.findById({ userId, documentId: attachment.id }))?.deletedAt).not.toBeNull();
    // Not shown as active in the library any more, but not gone either.
    await expect(documents.get({ userId, documentId: attachment.id })).rejects.toMatchObject({ code: "documents.not_found" });
  });

  it("restores a mail and the attachment trashed with it in the same cascade", async () => {
    const { mail, attachment } = await uploadMailAndAttachment();
    await documents.remove({ userId, documentId: mail.id });

    await documents.restore({ userId, documentId: mail.id });

    expect((await documents.get({ userId, documentId: mail.id })).deletedAt).toBeNull();
    expect((await documents.get({ userId, documentId: attachment.id })).deletedAt).toBeNull();
  });

  it("does not restore a child that was trashed on its own before its parent", async () => {
    const { mail, attachment } = await uploadMailAndAttachment();
    const repository = createDocumentsRepository({ db });
    // The attachment goes to trash by itself first, well before the mail does.
    await documents.remove({ userId, documentId: attachment.id });
    await repository.update({ userId, documentId: attachment.id, patch: { deletedAt: "2020-01-01T00:00:00.000Z" } });

    await documents.remove({ userId, documentId: mail.id });
    await documents.restore({ userId, documentId: mail.id });

    expect((await documents.get({ userId, documentId: mail.id })).deletedAt).toBeNull();
    // Restoring the mail is not a decision about an attachment the user trashed on its
    // own earlier, so it stays right where the user put it.
    const stillTrashed = await repository.findById({ userId, documentId: attachment.id });
    expect(stillTrashed?.deletedAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("purging a trashed mail deletes exactly the subtree that was trashed with it", async () => {
    const { mail, attachment } = await uploadMailAndAttachment();
    const { document: unrelated } = await documents.upload({ userId, name: "unrelated.txt", mimeType: "text/plain", body: Readable.from(["x"]) });

    await documents.remove({ userId, documentId: mail.id });
    await documents.purge({ userId, documentId: mail.id });

    const repository = createDocumentsRepository({ db });
    expect(await repository.findById({ userId, documentId: mail.id })).toBeNull();
    expect(await repository.findById({ userId, documentId: attachment.id })).toBeNull();
    expect(await repository.findById({ userId, documentId: unrelated.id })).not.toBeNull();
  });

  it("bulkDelete cascades trash to a document's children too", async () => {
    const { mail, attachment } = await uploadMailAndAttachment();

    const { count } = await documents.bulkDelete({ userId, documentIds: [mail.id] });

    expect(count).toBe(1);
    const repository = createDocumentsRepository({ db });
    expect((await repository.findById({ userId, documentId: attachment.id }))?.deletedAt).not.toBeNull();
  });

  it("collectSubtree tolerates a parentDocumentId cycle instead of looping forever", async () => {
    const repository = createDocumentsRepository({ db });
    const t = new Date().toISOString();
    const base: Omit<NewDocument, "id" | "name" | "parentDocumentId"> = {
      userId, mimeType: "text/plain", sizeBytes: 1, contentHash: null, storageDriver: "local", storageKey: "k",
      extractedText: "", extractionStatus: "done", extractionError: null, ruleStatus: "done", ruleError: null,
      embeddingStatus: "pending", embeddingError: null, categoryId: null, categorySource: null,
      triageStatus: "reviewed", createdAt: t, updatedAt: t,
    };
    await repository.insert({ ...base, id: "doc_a000000000000001", name: "a", storageKey: "a-key", parentDocumentId: null });
    await repository.insert({ ...base, id: "doc_b000000000000002", name: "b", storageKey: "b-key", parentDocumentId: "doc_a000000000000001" });
    // Manually wires the cycle: parentDocumentId is only ever set at creation to an
    // existing document in the real application flow, never edited afterward.
    await repository.update({ userId, documentId: "doc_a000000000000001", patch: { parentDocumentId: "doc_b000000000000002" } });

    await documents.purge({ userId, documentId: "doc_a000000000000001" });

    expect(await repository.findById({ userId, documentId: "doc_a000000000000001" })).toBeNull();
    expect(await repository.findById({ userId, documentId: "doc_b000000000000002" })).toBeNull();
  });

  it("collectSubtree stops at a depth cap rather than recursing without bound", async () => {
    const repository = createDocumentsRepository({ db });
    const t = new Date().toISOString();
    let parentDocumentId: string | null = null;
    for (let i = 0; i < 60; i++) {
      const id = `doc_${i.toString(16).padStart(16, "0")}`;
      await repository.insert({
        id, userId, name: `n${i}`, mimeType: "text/plain", sizeBytes: 1, contentHash: null,
        storageDriver: "local", storageKey: `key-${i}`, extractedText: "", extractionStatus: "done",
        extractionError: null, ruleStatus: "done", ruleError: null, embeddingStatus: "pending",
        embeddingError: null, categoryId: null, categorySource: null, triageStatus: "reviewed",
        parentDocumentId, createdAt: t, updatedAt: t,
      });
      parentDocumentId = id;
    }
    const rootId = "doc_0000000000000000";

    await expect(documents.purge({ userId, documentId: rootId })).rejects.toMatchObject({ code: "documents.subtree_too_deep" });
  });
});

describe("documents service filters and enrichment", () => {
  it("filters by view: inbox is triageStatus pending, needs_review is done with no category", async () => {
    const { document: inInbox } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const { document: reviewed } = await documents.upload({ userId, name: "b.txt", mimeType: "text/plain", body: Readable.from(["b"]) });
    const repository = createDocumentsRepository({ db });
    await repository.update({ userId, documentId: reviewed.id, patch: { triageStatus: "reviewed", ruleStatus: "done" } });

    const inbox = await documents.list({ userId, view: "inbox" });
    expect(inbox.map((d) => d.id)).toEqual([inInbox.id]);

    const needsReview = await documents.list({ userId, view: "needs_review" });
    expect(needsReview.map((d) => d.id)).toEqual([reviewed.id]);

    await repository.update({ userId, documentId: reviewed.id, patch: { categoryId: "cat_0000000000000001", categorySource: "manual" } });
    expect((await documents.list({ userId, view: "needs_review" })).map((d) => d.id)).toEqual([]);
  });

  it("counts() reports inbox and needs_review sizes without returning full rows", async () => {
    await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const { document: reviewed } = await documents.upload({ userId, name: "b.txt", mimeType: "text/plain", body: Readable.from(["b"]) });
    const repository = createDocumentsRepository({ db });
    await repository.update({ userId, documentId: reviewed.id, patch: { triageStatus: "reviewed", ruleStatus: "done" } });

    expect(await documents.counts({ userId })).toEqual({ inbox: 1, needsReview: 1, trash: 0 });
    expect(await documents.counts({ userId: "someone-else" })).toEqual({ inbox: 0, needsReview: 0, trash: 0 });
  });

  it("lists only the documents held on the active storage", async () => {
    const { document: elsewhere } = await documents.upload({ userId, name: "elsewhere.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const { document: here } = await documents.upload({ userId, name: "here.txt", mimeType: "text/plain", body: Readable.from(["b"]) });
    await db.run(sql`update documents set storage_driver = 's3' where id = ${elsewhere.id}`);

    const listed = await documents.list({ userId });

    expect(listed.map((d) => d.id)).toEqual([here.id]);
  });

  it("counts only the documents held on the active storage", async () => {
    const { document } = await documents.upload({ userId, name: "gone.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    await db.run(sql`update documents set storage_driver = 's3', triage_status = 'pending' where id = ${document.id}`);

    expect((await documents.counts({ userId })).inbox).toBe(0);
  });

  it("refuses to open a file held on another storage, and says where it is", async () => {
    const { document } = await documents.upload({ userId, name: "elsewhere.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    // The s3 driver needs its settings filled to be built at all, even to describe
    // where a file is offline. Values here are never sent anywhere.
    await settingsService.set(userId, {
      "storage.s3.bucket": "test-bucket",
      "storage.s3.region": "us-east-1",
      "storage.s3.accessKeyId": "test-key",
      "storage.s3.secretAccessKey": "test-secret",
    });
    await db.run(sql`update documents set storage_driver = 's3' where id = ${document.id}`);

    await expectAppError(() => documents.openFile({ userId, documentId: document.id }), "documents.storage_inactive");

    // The metadata is knowledge and stays reachable.
    expect((await documents.get({ userId, documentId: document.id })).id).toBe(document.id);
  });

  it("refuses to open a file whose driver cannot be built, and still names the storage without a location", async () => {
    const { document } = await documents.upload({ userId, name: "elsewhere.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    // No s3 settings configured this time, so building the driver to describe the
    // location fails with storage.driver_not_configured. The guard must not leak that
    // and must still refuse the read.
    await db.run(sql`update documents set storage_driver = 's3' where id = ${document.id}`);

    let caught: unknown;
    try {
      await documents.openFile({ userId, documentId: document.id });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code: string } | undefined)?.code).toBe("documents.storage_inactive");
    expect((caught as Error).message).toContain("s3");
    expect((caught as Error).message).not.toContain("s3://");
  });

  it("get() reports a null storage location while the document is on the active storage", async () => {
    const { document } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const detail = await documents.get({ userId, documentId: document.id });
    expect(detail.storageLocation).toBeNull();
  });

  it("get() includes the storage location computed from the document's own driver when it is off the active storage", async () => {
    const { document } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    await settingsService.set(userId, {
      "storage.s3.bucket": "test-bucket",
      "storage.s3.region": "us-east-1",
      "storage.s3.accessKeyId": "test-key",
      "storage.s3.secretAccessKey": "test-secret",
    });
    await db.run(sql`update documents set storage_driver = 's3' where id = ${document.id}`);
    const detail = await documents.get({ userId, documentId: document.id });
    expect(detail.storageLocation).toMatchObject({ label: expect.stringContaining("a.txt") });
  });

  it("get() reports a null storage location when the document is off the active storage and its driver cannot be built", async () => {
    const { document } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    await db.run(sql`update documents set storage_driver = 's3' where id = ${document.id}`);
    const detail = await documents.get({ userId, documentId: document.id });
    expect(detail.storageLocation).toBeNull();
  });

  it("get() still shows the storage location for a Google Drive document right after the account is disconnected", async () => {
    const { document } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    // No googleDrive settings at all: clientId, clientSecret and refreshToken are all
    // unset, exactly the state right after clicking Disconnect on the Storage tab.
    // Building the driver would fail with storage.driver_not_configured, but the
    // pointer to the original file must survive that regardless.
    await db.run(sql`update documents set storage_driver = 'googleDrive', storage_key = '1a2b3c' where id = ${document.id}`);

    const detail = await documents.get({ userId, documentId: document.id });

    expect(detail.storageLocation).toEqual({
      label: "Google Drive file 1a2b3c",
      url: "https://drive.google.com/file/d/1a2b3c/view",
    });
  });

  it("filters by categoryId including descendants, and by tagId", async () => {
    const tags = createTestTagsService({ db });
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

  it("filters by documentTypeId and resolves the type name onto each row", async () => {
    const tags = createTestTagsService({ db });
    const invoice = await tags.createType({ userId, name: "Invoice" });
    const receipt = await tags.createType({ userId, name: "Receipt" });
    const repository = createDocumentsRepository({ db });

    const { document: anInvoice } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const { document: aReceipt } = await documents.upload({ userId, name: "b.txt", mimeType: "text/plain", body: Readable.from(["b"]) });
    const { document: untyped } = await documents.upload({ userId, name: "c.txt", mimeType: "text/plain", body: Readable.from(["c"]) });
    await repository.update({ userId, documentId: anInvoice.id, patch: { documentTypeId: invoice.id, documentTypeSource: "manual" } });
    await repository.update({ userId, documentId: aReceipt.id, patch: { documentTypeId: receipt.id, documentTypeSource: "auto" } });

    const all = await documents.list({ userId });
    expect(all.find((d) => d.id === anInvoice.id)?.documentTypeName).toBe("Invoice");
    expect(all.find((d) => d.id === aReceipt.id)?.documentTypeName).toBe("Receipt");
    expect(all.find((d) => d.id === untyped.id)?.documentTypeName).toBeNull();

    const byInvoice = await documents.list({ userId, documentTypeId: invoice.id });
    expect(byInvoice.map((d) => d.id)).toEqual([anInvoice.id]);
    expect(byInvoice[0]?.documentTypeName).toBe("Invoice");
  });

  it("get() resolves the document type name for a single document", async () => {
    const tags = createTestTagsService({ db });
    const invoice = await tags.createType({ userId, name: "Invoice" });
    const repository = createDocumentsRepository({ db });
    const { document } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    await repository.update({ userId, documentId: document.id, patch: { documentTypeId: invoice.id, documentTypeSource: "manual" } });

    const detail = await documents.get({ userId, documentId: document.id });
    expect(detail).toMatchObject({ documentTypeId: invoice.id, documentTypeName: "Invoice" });
  });

  it("combines categoryId and tagId filters with AND", async () => {
    const tags = createTestTagsService({ db });
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
    const tags = createTestTagsService({ db });
    const category = await tags.createCategory({ userId, name: "Finance" });
    const { document } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    await tags.setDocumentCategory({ userId, documentId: document.id, categoryId: category.id });
    const detail = await documents.get({ userId, documentId: document.id });
    expect(detail).toMatchObject({ categoryId: category.id, categoryPath: "Finance", tags: [] });
  });

  it("get() names the mail behind an attachment, and the attachments filed with a mail", async () => {
    const { document: mail } = await documents.upload({ userId, name: "mail.txt", mimeType: "text/plain", body: Readable.from(["body"]), source: "email" });
    const { document: attachment } = await documents.upload({
      userId, name: "invoice.pdf", mimeType: "application/pdf", body: Readable.from(["pdf"]),
      source: "email", parentDocumentId: mail.id,
    });

    const mailDetail = await documents.get({ userId, documentId: mail.id });
    expect(mailDetail.parent).toBeNull();
    expect(mailDetail.children).toEqual([{ id: attachment.id, name: "invoice.pdf" }]);

    const attachmentDetail = await documents.get({ userId, documentId: attachment.id });
    expect(attachmentDetail.parent).toEqual({ id: mail.id, name: "mail.txt" });
    expect(attachmentDetail.children).toEqual([]);
  });

  it("get() leaves out a child that has been trashed", async () => {
    const { document: mail } = await documents.upload({ userId, name: "mail.txt", mimeType: "text/plain", body: Readable.from(["body"]), source: "email" });
    const { document: attachment } = await documents.upload({
      userId, name: "invoice.pdf", mimeType: "application/pdf", body: Readable.from(["pdf"]),
      source: "email", parentDocumentId: mail.id,
    });
    await documents.remove({ userId, documentId: attachment.id });

    const mailDetail = await documents.get({ userId, documentId: mail.id });
    expect(mailDetail.children).toEqual([]);
  });

  it("get() has no parent or children for a document with neither", async () => {
    const { document } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const detail = await documents.get({ userId, documentId: document.id });
    expect(detail.parent).toBeNull();
    expect(detail.children).toEqual([]);
  });

  it("get() and list() embed the document's smart fields", async () => {
    const { document } = await documents.upload({ userId, name: "invoice.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    await createFieldsRepository({ db }).replaceForDocument({
      userId,
      documentId: document.id,
      fields: [{ key: "counterparty", value: "Acme", valueNumber: null, valueDate: null, currency: null, confidence: null }],
    });

    const detail = await documents.get({ userId, documentId: document.id });
    expect(detail.fields).toEqual([expect.objectContaining({ key: "counterparty", value: "Acme" })]);

    const [listed] = await documents.list({ userId });
    expect(listed?.fields).toEqual([expect.objectContaining({ key: "counterparty", value: "Acme" })]);
  });

  it("upload() returns the enriched row with categoryPath and tags", async () => {
    const { document } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    expect(document).toHaveProperty("categoryPath");
    expect(Array.isArray(document.tags)).toBe(true);
  });

  it("upload() returns the enriched duplicate row with categoryPath and tags", async () => {
    const first = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["same"]) });
    const second = await documents.upload({ userId, name: "b.txt", mimeType: "text/plain", body: Readable.from(["same"]) });
    expect(second.duplicateOf).toBe(first.document.id);
    expect(second.document).toHaveProperty("categoryPath");
    expect(Array.isArray(second.document.tags)).toBe(true);
  });

  it("rename() returns the enriched row with categoryPath and tags", async () => {
    const { document } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const renamed = await documents.rename({ userId, documentId: document.id, name: "renamed.txt" });
    expect(renamed.name).toBe("renamed.txt");
    expect(renamed).toHaveProperty("categoryPath");
    expect(Array.isArray(renamed.tags)).toBe(true);
  });

  it("rename() clears a pending suggestedTitle", async () => {
    const { document } = await documents.upload({ userId, name: "a.txt", mimeType: "text/plain", body: Readable.from(["a"]) });
    const repository = createDocumentsRepository({ db });
    await repository.update({ userId, documentId: document.id, patch: { suggestedTitle: "AI Suggested Name" } });
    expect((await documents.get({ userId, documentId: document.id })).suggestedTitle).toBe("AI Suggested Name");

    const renamed = await documents.rename({ userId, documentId: document.id, name: "renamed.txt" });
    expect(renamed.name).toBe("renamed.txt");
    expect(renamed.suggestedTitle).toBeNull();
  });

  it("needs_review includes a document with a pending proposal even when it already has a category", async () => {
    const { db: testDb } = await createTestDatabase();
    const docsRepo = createDocumentsRepository({ db: testDb });
    const { createRulesRepository } = await import("../rules/rules.repository.js");
    const rulesRepo = createRulesRepository({ db: testDb });
    const t = new Date().toISOString();
    const doc: NewDocument = {
      id: "doc_0000000000000001",
      userId: "user-1",
      name: "a.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      contentHash: "hash",
      storageDriver: "local",
      storageKey: "key",
      extractedText: "",
      extractionStatus: "done",
      extractionError: null,
      ruleStatus: "done",
      ruleError: null,
      embeddingStatus: "pending",
      embeddingError: null,
      categoryId: "cat_0000000000000001",
      categorySource: "manual",
      triageStatus: "reviewed",
      createdAt: t,
      updatedAt: t,
    };
    await docsRepo.insert(doc);
    await rulesRepo.insertEvaluations([
      {
        id: "eval_0000000000000001",
        documentId: doc.id,
        targetType: "category",
        targetId: "cat_0000000000000002",
        matched: 1,
        confidence: 0.9,
        reasoning: "x",
        outcome: "proposed",
        proposalKind: "set_category",
        modelId: "openrouter://test",
        jobId: "job_0000000000000001",
        contentHash: null,
        evaluatedAt: t,
      },
    ]);
    const rows = await docsRepo.listByUser({ userId: "user-1", view: "needs_review" });
    expect(rows.map((r) => r.id)).toEqual([doc.id]);
  });
});
