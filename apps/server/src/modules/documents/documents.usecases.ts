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
  // application step, not just as a side effect of the schema's own cascade.
  async function collectSubtree(userId: string, documentId: string): Promise<Document[]> {
    const document = await repository.findById({ userId, documentId });
    if (!document) throw notFound(documentId);
    const children = await repository.findChildren({ userId, documentId });
    const subtree = [document];
    for (const child of children) subtree.push(...(await collectSubtree(userId, child.id)));
    return subtree;
  }

  async function getEnrichedOrThrow(userId: string, documentId: string) {
    const row = await repository.findByIdWithExtras({ userId, documentId });
    if (!row || row.deletedAt) throw notFound(documentId);
    const storageLocation = await describeStorageLocation(userId, row);
    return { ...row, storageLocation };
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

      const existing = await repository.findByHash({ userId, contentHash: sha256 });
      if (existing) {
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
      tagId,
      view,
    }: {
      userId: string;
      categoryId?: string;
      tagId?: string;
      view?: DocumentView;
    }): Promise<DocumentListRow[]> {
      // The library is scoped to the storage the user is looking at. Background jobs
      // call the repository directly with no storageDriver, so they keep seeing
      // everything regardless of which storage is active.
      const storageDriver = await storageService.getActiveDriverId(userId);
      return repository.listByUser({ userId, categoryId, tagId, view, storageDriver });
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
      await repository.update({ userId, documentId, patch: { deletedAt: nowIso(), updatedAt: nowIso() } });
    },

    async restore({ userId, documentId }: { userId: string; documentId: string }) {
      const document = await repository.findById({ userId, documentId });
      if (!document) throw notFound(documentId);
      if (!document.deletedAt) throw createError({ code: "documents.not_deleted", message: "Document is not in trash", status: 400 });
      await repository.update({ userId, documentId, patch: { deletedAt: null, updatedAt: nowIso() } });
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
      const now = nowIso();
      let count = 0;
      for (const documentId of documentIds) {
        const doc = await repository.findById({ userId, documentId });
        if (doc && !doc.deletedAt) {
          await repository.update({ userId, documentId, patch: { deletedAt: now, updatedAt: now } });
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
