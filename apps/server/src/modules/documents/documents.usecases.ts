import { PassThrough, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createError } from "../../shared/errors/errors.js";
import { asTxDb, type Database } from "../database/database.js";
import { buildStorageKey, type StorageService } from "../storage/storage.usecases.js";
import { hashingCounter, newDocumentId, nowIso, sanitizeFilename } from "./documents.models.js";
import { createDocumentsRepository } from "./documents.repository.js";
import type { Document, DocumentListRow, DocumentView } from "./documents.types.js";

function notFound(documentId: string) {
  return createError({ code: "documents.not_found", message: `Document "${documentId}" not found`, status: 404 });
}

const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export function createDocumentsService({
  db,
  storageService,
  onUploaded,
}: {
  db: Database;
  storageService: StorageService;
  onUploaded?: (args: { userId: string; document: Document; tx: Database }) => Promise<void>;
}) {
  const repository = createDocumentsRepository({ db });

  async function getOrThrow(userId: string, documentId: string): Promise<Document> {
    const document = await repository.findById({ userId, documentId });
    if (!document || document.deletedAt) throw notFound(documentId);
    return document;
  }

  // A document on the active storage has its bytes reachable right here, so there is
  // nothing to point at. Resolving the location never builds a driver: it needs no
  // credentials and no client, so a document keeps pointing at its original file even
  // right after the storage that holds it was disconnected. Any remaining failure, for
  // example a setting the location itself depends on being missing entirely, must never
  // block reading the record: it just means the location cannot be shown.
  async function describeStorageLocation(userId: string, document: Document) {
    const active = await storageService.getActiveDriverId(userId);
    if (document.storageDriver === active) return null;
    try {
      return await storageService.describeLocation(userId, document.storageDriver, document.storageKey);
    } catch {
      return null;
    }
  }

  // A document plus every descendant reached through parentDocumentId, root first. Used
  // by purge() so deleting a mail takes its attachments with it as an explicit
  // application step, not just as a side effect of the schema's own cascade, and by the
  // trash and restore cascades below.
  //
  // parentDocumentId is only ever set at creation to an existing document today, so a
  // cycle cannot happen through normal use, but it is one direct edit of that column
  // away from turning this into unbounded recursion. The visited set makes a cycle a
  // no-op instead of a stack overflow, and the depth cap catches a runaway chain of
  // ordinary parent links before it does real damage.
  const MAX_SUBTREE_DEPTH = 50;

  async function collectSubtree(userId: string, documentId: string, visited = new Set<string>(), depth = 0): Promise<Document[]> {
    if (depth > MAX_SUBTREE_DEPTH) {
      throw createError({
        code: "documents.subtree_too_deep",
        message: "This document's parent chain is nested too deep to process",
        status: 500,
      });
    }
    if (visited.has(documentId)) return [];
    visited.add(documentId);
    const document = await repository.findById({ userId, documentId });
    if (!document) throw notFound(documentId);
    const children = await repository.findChildren({ userId, documentId });
    const subtree = [document];
    for (const child of children) subtree.push(...(await collectSubtree(userId, child.id, visited, depth + 1)));
    return subtree;
  }

  // Trashes documentId and every descendant that is not already in trash, all stamped
  // with the same deletedAt. Restoring reads that shared timestamp back to tell which
  // children moved to trash together with this document, as opposed to a child that was
  // already there on its own before this cascade ran.
  async function trashSubtree(userId: string, documentId: string) {
    const subtree = await collectSubtree(userId, documentId);
    const deletedAt = nowIso();
    await db.transaction(async (tx) => {
      const txDb = asTxDb(tx);
      for (const doc of subtree) {
        if (doc.deletedAt) continue;
        await repository.update({ userId, documentId: doc.id, patch: { deletedAt, updatedAt: deletedAt }, tx: txDb });
      }
    });
  }

  // The mail behind an attachment, and the attachments filed with a mail, so the detail
  // page can show the two as links instead of parentDocumentId sitting invisibly on the
  // row. Only active documents are named here: a trashed one is not shown as related
  // until it is either restored or gone for good.
  async function describeRelatives(userId: string, document: Document) {
    let parent: { id: string; name: string } | null = null;
    if (document.parentDocumentId) {
      const parentDoc = await repository.findById({ userId, documentId: document.parentDocumentId });
      if (parentDoc && !parentDoc.deletedAt) parent = { id: parentDoc.id, name: parentDoc.name };
    }
    const children = await repository.findChildren({ userId, documentId: document.id });
    return { parent, children: children.filter((c) => !c.deletedAt).map((c) => ({ id: c.id, name: c.name })) };
  }

  async function getEnrichedOrThrow(userId: string, documentId: string) {
    const row = await repository.findByIdWithExtras({ userId, documentId });
    if (!row || row.deletedAt) throw notFound(documentId);
    const [storageLocation, relatives] = await Promise.all([describeStorageLocation(userId, row), describeRelatives(userId, row)]);
    return { ...row, storageLocation, ...relatives };
  }

  // The bytes need their storage, the metadata does not. A document on an inactive
  // storage stays fully readable as a record and refuses only the file itself, with
  // the original's location in the message when it can be worked out.
  async function requireActiveStorage(userId: string, document: Document) {
    const active = await storageService.getActiveDriverId(userId);
    if (document.storageDriver === active) return;
    const location = await describeStorageLocation(userId, document);
    const whereItIs = location ? ` The original is at ${location.label}.` : "";
    throw createError({
      code: "documents.storage_inactive",
      message: `This file is stored on ${document.storageDriver}, which is not the active storage.${whereItIs}`,
      status: 409,
    });
  }

  return {
    async upload({
      userId,
      name,
      mimeType,
      body,
      maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES,
      source = "upload",
      parentDocumentId,
    }: {
      userId: string;
      name: string;
      mimeType?: string;
      body: Readable;
      maxUploadBytes?: number;
      source?: "upload" | "telegram" | "email";
      parentDocumentId?: string;
    }) {
      const documentId = newDocumentId();
      const safeName = sanitizeFilename(name);
      const uploadedAt = new Date();
      const driverId = await storageService.getActiveDriverId(userId);
      const driver = await storageService.getDriver(userId, driverId);
      const key = buildStorageKey({ userId, documentId, filename: safeName, uploadedAt });

      const counter = hashingCounter();
      const toStorage = new PassThrough();
      const [, stored] = await Promise.all([
        pipeline(body, counter.transform, toStorage),
        driver.put({ key, body: toStorage, mimeType }),
      ]);
      const { sha256, sizeBytes } = counter.result();

      if (sizeBytes > maxUploadBytes) {
        await driver.delete({ key: stored.key });
        throw createError({ code: "documents.too_large", message: `Uploads are limited to ${maxUploadBytes} bytes`, status: 413 });
      }

      // A hash match is only the same upload when it also carries this call's own
      // parent, or neither call has one. A mail retried mid-move lands here with the
      // exact parentDocumentId it used before, so reusing the row keeps retries safe.
      // A different mail, or a plain upload, must not reuse a row parented elsewhere
      // (or not parented at all): parentDocumentId is only ever set at creation, so
      // the existing row is left untouched and this call gets its own child row
      // instead, with the bytes already written above kept rather than deleted.
      const existing = await repository.findByHash({ userId, contentHash: sha256 });
      const shouldReuse = existing !== null && (existing.parentDocumentId ?? null) === (parentDocumentId ?? null);
      if (shouldReuse) {
        await driver.delete({ key: stored.key });
        return { document: await getEnrichedOrThrow(userId, existing.id), duplicateOf: existing.id };
      }

      const timestamp = uploadedAt.toISOString();
      const document: Document = {
        id: documentId,
        userId,
        name: safeName,
        mimeType: mimeType ?? null,
        sizeBytes,
        contentHash: sha256,
        storageDriver: driverId,
        storageKey: stored.key,
        source,
        extractedText: null,
        extractionStatus: "pending",
        extractionError: null,
        ruleStatus: "pending",
        ruleError: null,
        embeddingStatus: "pending",
        embeddingError: null,
        summary: null,
        suggestedTitle: null,
        summaryStatus: "pending",
        summaryError: null,
        categoryId: null,
        categorySource: null,
        documentTypeId: null,
        documentTypeSource: null,
        documentDate: null,
        triageStatus: "pending",
        parentDocumentId: parentDocumentId ?? null,
        deletedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await db.transaction(async (tx) => {
        await repository.insert(document, asTxDb(tx));
        if (onUploaded) await onUploaded({ userId, document, tx: asTxDb(tx) });
      });
      return { document: await getEnrichedOrThrow(userId, documentId) };
    },

    async list({
      userId,
      categoryId,
      documentTypeId,
      tagId,
      view,
    }: {
      userId: string;
      categoryId?: string;
      documentTypeId?: string;
      tagId?: string;
      view?: DocumentView;
    }): Promise<DocumentListRow[]> {
      // The library is scoped to the storage the user is looking at. Background jobs
      // call the repository directly with no storageDriver, so they keep seeing
      // everything regardless of which storage is active.
      const storageDriver = await storageService.getActiveDriverId(userId);
      return repository.listByUser({ userId, categoryId, documentTypeId, tagId, view, storageDriver });
    },

    get({ userId, documentId }: { userId: string; documentId: string }) {
      return getEnrichedOrThrow(userId, documentId);
    },

    async counts({ userId }: { userId: string }): Promise<{ inbox: number; needsReview: number; trash: number }> {
      // The sidebar badges are counts of the library the user is looking at, so they
      // follow the same active-storage scope as list().
      const storageDriver = await storageService.getActiveDriverId(userId);
      const [inbox, needsReview, trash] = await Promise.all([
        repository.countByUser({ userId, view: "inbox", storageDriver }),
        repository.countByUser({ userId, view: "needs_review", storageDriver }),
        repository.countByUser({ userId, view: "trash", storageDriver }),
      ]);
      return { inbox, needsReview, trash };
    },

    async rename({ userId, documentId, name }: { userId: string; documentId: string; name: string }) {
      await getOrThrow(userId, documentId);
      // A manual rename overrides any pending suggestion so the accept-title badge
      // stops showing for a title the user has already replaced by hand.
      await repository.update({ userId, documentId, patch: { name: sanitizeFilename(name), suggestedTitle: null, updatedAt: nowIso() } });
      return getEnrichedOrThrow(userId, documentId);
    },

    async remove({ userId, documentId }: { userId: string; documentId: string }) {
      await getOrThrow(userId, documentId);
      // A mail and the attachments it arrived with move to trash together, so purge
      // later never has to reach past the trash to destroy something still active.
      await trashSubtree(userId, documentId);
    },

    async restore({ userId, documentId }: { userId: string; documentId: string }) {
      const document = await repository.findById({ userId, documentId });
      if (!document) throw notFound(documentId);
      if (!document.deletedAt) throw createError({ code: "documents.not_deleted", message: "Document is not in trash", status: 400 });
      // Only descendants stamped with this document's own deletedAt come back with it:
      // those trashed in the same cascade. A child trashed on its own, at a different
      // time, keeps its own trash timestamp and stays in trash. Restoring a parent is
      // not a decision the user made about a child they trashed separately.
      const trashedAt = document.deletedAt;
      const subtree = await collectSubtree(userId, documentId);
      const updatedAt = nowIso();
      await db.transaction(async (tx) => {
        const txDb = asTxDb(tx);
        for (const doc of subtree) {
          if (doc.deletedAt !== trashedAt) continue;
          await repository.update({ userId, documentId: doc.id, patch: { deletedAt: null, updatedAt }, tx: txDb });
        }
      });
      return getEnrichedOrThrow(userId, documentId);
    },

    async purge({ userId, documentId }: { userId: string; documentId: string }) {
      const subtree = await collectSubtree(userId, documentId);
      for (const doc of subtree) await requireActiveStorage(userId, doc);
      // Deepest descendants first, the requested document last. The schema also cascades
      // this through parentDocumentId's ON DELETE CASCADE, but that only fires when
      // foreign keys are enabled on the connection that runs the delete, a property of
      // how the database was opened rather than of the data. Deleting children here
      // explicitly means purge() removes the same rows and files either way.
      for (const doc of [...subtree].reverse()) {
        const driver = await storageService.getDriver(userId, doc.storageDriver);
        await driver.delete({ key: doc.storageKey });
        await repository.remove({ userId, documentId: doc.id });
      }
    },

    async openFile({ userId, documentId }: { userId: string; documentId: string }) {
      const document = await getOrThrow(userId, documentId);
      await requireActiveStorage(userId, document);
      const driver = await storageService.getDriver(userId, document.storageDriver);
      const stream = await driver.get({ key: document.storageKey });
      return { document, stream };
    },

    async acceptTriage({ userId, documentId, acceptTitle = false }: { userId: string; documentId: string; acceptTitle?: boolean }) {
      const document = await getOrThrow(userId, documentId);
      if (document.triageStatus !== "pending") {
        throw createError({ code: "documents.already_reviewed", message: "Document is already reviewed", status: 400 });
      }
      const patch: Record<string, unknown> = { triageStatus: "reviewed", updatedAt: nowIso() };
      if (acceptTitle && document.suggestedTitle) {
        patch.name = document.suggestedTitle;
        patch.suggestedTitle = null;
      }
      await repository.update({ userId, documentId, patch });
      return getEnrichedOrThrow(userId, documentId);
    },

    async acceptTriageBatch({ userId, documentIds }: { userId: string; documentIds: string[] }) {
      const updatedCount = await repository.updateTriageStatusBatch({ userId, documentIds, status: "reviewed" });
      return { updatedCount };
    },

    async bulkDelete({ userId, documentIds }: { userId: string; documentIds: string[] }) {
      let count = 0;
      for (const documentId of documentIds) {
        const doc = await repository.findById({ userId, documentId });
        if (doc && !doc.deletedAt) {
          // Same cascade as remove(): a document's children go to trash with it.
          await trashSubtree(userId, documentId);
          count++;
        }
      }
      return { count };
    },

    async bulkTag({ userId, documentIds, tagId, action }: { userId: string; documentIds: string[]; tagId: string; action: "add" | "remove" }) {
      let count = 0;
      for (const documentId of documentIds) {
        const doc = await repository.findById({ userId, documentId });
        if (!doc || doc.deletedAt) continue;
        count++;
      }
      return { count, tagId, action };
    },

    async bulkCategory({ userId, documentIds, categoryId }: { userId: string; documentIds: string[]; categoryId: string | null }) {
      const now = nowIso();
      let count = 0;
      for (const documentId of documentIds) {
        const doc = await repository.findById({ userId, documentId });
        if (!doc || doc.deletedAt) continue;
        await repository.update({ userId, documentId, patch: { categoryId, categorySource: categoryId ? "manual" : null, updatedAt: now } });
        count++;
      }
      return { count };
    },
  };
}

export type DocumentsService = ReturnType<typeof createDocumentsService>;
