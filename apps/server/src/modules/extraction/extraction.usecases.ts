import type { Readable } from "node:stream";
import * as v from "valibot";
import { createError } from "../../shared/errors/errors.js";
import { parseOrValidationError } from "../../shared/http/validate.js";
import { asTxDb, type Database } from "../database/database.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import type { DocumentsService } from "../documents/documents.usecases.js";
import type { JobHandler } from "../jobs/jobs.runner.js";
import type { Job } from "../jobs/jobs.types.js";
import { createJobsService } from "../jobs/jobs.usecases.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import type { RulesService } from "../rules/rules.usecases.js";
import type { ExtractorRegistry } from "./extraction.registry.js";
import { extractionPayloadSchema } from "./extraction.schemas.js";

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
  rulesService,
}: {
  db: Database;
  documentsService: DocumentsService;
  settingsService: SettingsService;
  registry: ExtractorRegistry;
  rulesService: Pick<RulesService, "hasAutomaticItems">;
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
        stream.destroy();
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
      const hasAutoItems = await rulesService.hasAutomaticItems(userId);
      await db.transaction(async (tx) => {
        const txDb = asTxDb(tx);
        await documents.update({
          userId,
          documentId,
          patch: {
            extractedText: result.text,
            extractionStatus: "done",
            extractionError: result.note ?? null,
            ruleStatus: hasAutoItems ? "pending" : "done",
            updatedAt: now(),
          },
          tx: txDb,
        });
        if (hasAutoItems) {
          await jobs.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "initial" }, tx: txDb });
        }
      });
    } catch (error) {
      const message = ((error as Error).message ?? String(error)).slice(0, 2000);
      await documents.update({
        userId,
        documentId,
        patch: {
          extractionStatus: isFinalAttempt ? "failed" : "pending",
          extractionError: message,
          ...(isFinalAttempt ? { ruleStatus: "failed" as const, ruleError: "Extraction failed" } : {}),
          updatedAt: now(),
        },
      });
      throw error;
    }
  }

  function parseExtractionPayload(raw: string): v.InferOutput<typeof extractionPayloadSchema> {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw createError({ code: "extraction.invalid_payload", message: "Extraction job payload is not valid JSON", status: 500 });
    }
    return parseOrValidationError(extractionPayloadSchema, value);
  }

  async function findActiveJob({ userId, documentId }: { userId: string; documentId: string }): Promise<Job | null> {
    const userJobs = await jobs.list({ userId });
    for (const job of userJobs) {
      if (job.type !== "extraction") continue;
      if (job.status !== "pending" && job.status !== "processing") continue;
      let raw: unknown;
      try {
        raw = JSON.parse(job.payload);
      } catch {
        continue;
      }
      const parsed = v.safeParse(extractionPayloadSchema, raw);
      if (parsed.success && parsed.output.documentId === documentId) return job;
    }
    return null;
  }

  const handler: JobHandler = async (job) => {
    const payload = parseExtractionPayload(job.payload);
    await extractDocument({
      userId: payload.userId,
      documentId: payload.documentId,
      isFinalAttempt: job.attempts >= job.maxAttempts,
    });
  };

  async function requestExtraction({ userId, documentId }: { userId: string; documentId: string }) {
    await documentsService.get({ userId, documentId });
    const active = await findActiveJob({ userId, documentId });
    if (active) return active;
    return db.transaction(async (tx) => {
      await documents.update({
        userId,
        documentId,
        patch: { extractionStatus: "pending", extractionError: null, updatedAt: new Date().toISOString() },
        tx: asTxDb(tx),
      });
      return jobs.enqueue({ userId, type: "extraction", payload: { documentId, userId }, tx: asTxDb(tx) });
    });
  }

  return { extractDocument, handler, requestExtraction };
}

export type ExtractionService = ReturnType<typeof createExtractionService>;
