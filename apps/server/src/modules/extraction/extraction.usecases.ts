import type { Readable } from "node:stream";
import { createError } from "../../shared/errors/errors.js";
import type { Database } from "../database/database.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import type { DocumentsService } from "../documents/documents.usecases.js";
import type { JobHandler } from "../jobs/jobs.runner.js";
import { createJobsService } from "../jobs/jobs.usecases.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import type { ExtractorRegistry } from "./extraction.registry.js";

async function readAll(stream: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const joined = Buffer.concat(chunks);
  return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
}

export function createExtractionService({
  db,
  documentsService,
  settingsService,
  registry,
}: {
  db: Database;
  documentsService: DocumentsService;
  settingsService: SettingsService;
  registry: ExtractorRegistry;
}) {
  const documents = createDocumentsRepository({ db });
  const jobs = createJobsService({ db });

  async function extractDocument({
    userId,
    documentId,
    isFinalAttempt = true,
  }: {
    userId: string;
    documentId: string;
    isFinalAttempt?: boolean;
  }) {
    const now = () => new Date().toISOString();
    try {
      await documents.update({ userId, documentId, patch: { extractionStatus: "processing", updatedAt: now() } });
      const { document, stream } = await documentsService.openFile({ userId, documentId });
      const extractor = registry.find(document.mimeType ?? "", document.name);
      if (!extractor) {
        throw createError({
          code: "extraction.unsupported",
          message: `No extractor for ${document.mimeType ?? "unknown"} (${document.name})`,
          status: 422,
        });
      }
      const bytes = await readAll(stream);
      const ctx = {
        ocrLanguages: (await settingsService.get<string>(userId, "extraction.ocrLanguages")) ?? "eng",
        dataDir: (await settingsService.get<string>(userId, "extraction.dataDir")) ?? "./data",
      };
      const result = await extractor.extract({ bytes, mimeType: document.mimeType ?? "", filename: document.name }, ctx);
      await documents.update({
        userId,
        documentId,
        patch: { extractedText: result.text, extractionStatus: "done", extractionError: result.note ?? null, updatedAt: now() },
      });
    } catch (error) {
      const message = ((error as Error).message ?? String(error)).slice(0, 2000);
      await documents.update({
        userId,
        documentId,
        patch: { extractionStatus: isFinalAttempt ? "failed" : "pending", extractionError: message, updatedAt: now() },
      });
      throw error;
    }
  }

  const handler: JobHandler = async (job) => {
    const payload = JSON.parse(job.payload) as { documentId: string; userId: string };
    await extractDocument({
      userId: payload.userId ?? job.userId,
      documentId: payload.documentId,
      isFinalAttempt: job.attempts >= job.maxAttempts,
    });
  };

  async function requestExtraction({ userId, documentId }: { userId: string; documentId: string }) {
    await documentsService.get({ userId, documentId });
    return db.transaction(async (tx) => {
      await documents.update({
        userId,
        documentId,
        patch: { extractionStatus: "pending", extractionError: null, updatedAt: new Date().toISOString() },
        tx: tx as unknown as Database,
      });
      return jobs.enqueue({ userId, type: "extraction", payload: { documentId, userId }, tx: tx as unknown as Database });
    });
  }

  return { extractDocument, handler, requestExtraction };
}

export type ExtractionService = ReturnType<typeof createExtractionService>;
