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
    if (!document) throw notFound(documentId);
    return document;
  }

  async function getEnrichedOrThrow(userId: string, documentId: string) {
    const row = await repository.findByIdWithExtras({ userId, documentId });
    if (!row) throw notFound(documentId);
    return row;
  }

  return {
    async upload({
      userId,
      name,
      mimeType,
      body,
      maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES,
    }: {
      userId: string;
      name: string;
      mimeType?: string;
      body: Readable;
      maxUploadBytes?: number;
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
        extractedText: null,
        extractionStatus: "pending",
        extractionError: null,
        ruleStatus: "pending",
        ruleError: null,
        embeddingStatus: "pending",
        embeddingError: null,
        categoryId: null,
        categorySource: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await db.transaction(async (tx) => {
        await repository.insert(document, asTxDb(tx));
        if (onUploaded) await onUploaded({ userId, document, tx: asTxDb(tx) });
      });
      return { document: await getEnrichedOrThrow(userId, documentId) };
    },

    list({
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
      return repository.listByUser({ userId, categoryId, tagId, view });
    },

    get({ userId, documentId }: { userId: string; documentId: string }) {
      return getEnrichedOrThrow(userId, documentId);
    },

    async counts({ userId }: { userId: string }): Promise<{ inbox: number; needsReview: number }> {
      const [inbox, needsReview] = await Promise.all([
        repository.countByUser({ userId, view: "inbox" }),
        repository.countByUser({ userId, view: "needs_review" }),
      ]);
      return { inbox, needsReview };
    },

    async rename({ userId, documentId, name }: { userId: string; documentId: string; name: string }) {
      await getOrThrow(userId, documentId);
      await repository.update({ userId, documentId, patch: { name: sanitizeFilename(name), updatedAt: nowIso() } });
      return getEnrichedOrThrow(userId, documentId);
    },

    async remove({ userId, documentId }: { userId: string; documentId: string }) {
      const document = await getOrThrow(userId, documentId);
      const driver = await storageService.getDriver(userId, document.storageDriver);
      await driver.delete({ key: document.storageKey });
      await repository.remove({ userId, documentId });
    },

    async openFile({ userId, documentId }: { userId: string; documentId: string }) {
      const document = await getOrThrow(userId, documentId);
      const driver = await storageService.getDriver(userId, document.storageDriver);
      const stream = await driver.get({ key: document.storageKey });
      return { document, stream };
    },
  };
}

export type DocumentsService = ReturnType<typeof createDocumentsService>;
