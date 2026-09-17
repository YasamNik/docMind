import type { Readable } from "node:stream";
import * as v from "valibot";
import { createError } from "../../shared/errors/errors.js";
import { parseOrValidationError } from "../../shared/http/validate.js";
import { createLogger, type Logger } from "../../shared/logger/logger.js";
import { asTxDb, type Database } from "../database/database.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import type { DocumentsService } from "../documents/documents.usecases.js";
import type { JobHandler } from "../jobs/jobs.runner.js";
import type { Job } from "../jobs/jobs.types.js";
import { createJobsService } from "../jobs/jobs.usecases.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import type { RulesService } from "../rules/rules.usecases.js";
import type { AiService } from "../ai/ai.usecases.js";
import { VISION_OCR_PROMPT, normalizeText } from "./extraction.models.js";
import type { ExtractorRegistry } from "./extraction.registry.js";
import { extractionPayloadSchema } from "./extraction.schemas.js";

const DEFAULT_OCR_CONFIDENCE_THRESHOLD = 60;

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
  aiService,
  logger = createLogger("extraction"),
}: {
  db: Database;
  documentsService: DocumentsService;
  settingsService: SettingsService;
  registry: ExtractorRegistry;
  rulesService: Pick<RulesService, "hasAutomaticItems">;
  aiService?: Pick<AiService, "recognizeImage">;
  logger?: Logger;
}) {
  const documents = createDocumentsRepository({ db });
  const jobs = createJobsService({ db });

  async function applyVisionFallback({
    userId,
    documentId,
    bytes,
    mimeType,
    result,
  }: {
    userId: string;
    documentId: string;
    bytes: Uint8Array;
    mimeType: string;
    result: { text: string; note?: string; confidence?: number };
  }): Promise<{ text: string; note?: string; confidence?: number }> {
    if (!aiService) return result;
    if (result.confidence === undefined) return result;
    const threshold =
      (await settingsService.get<number>(userId, "ai.vision.ocrConfidenceThreshold")) ?? DEFAULT_OCR_CONFIDENCE_THRESHOLD;
    if (result.confidence >= threshold) return result;

    const visionModel = await settingsService.get<string>(userId, "ai.model.vision");
    if (!visionModel) return result;

    try {
      const visionResult = await aiService.recognizeImage({
        userId,
        image: Buffer.from(bytes),
        mimeType: mimeType || "image/png",
        prompt: VISION_OCR_PROMPT,
      });
      const visionText = normalizeText(visionResult.text);
      if (!visionText) {
        logger.info({ documentId, confidence: result.confidence }, "Vision LLM fallback returned no text, keeping OCR result");
        return {
          ...result,
          note: `Vision LLM returned no text. Using OCR result (confidence: ${result.confidence.toFixed(0)}).`,
        };
      }
      logger.info({ documentId, confidence: result.confidence }, "Vision LLM fallback used in place of OCR result");
      return {
        text: visionText,
        confidence: result.confidence,
        note: `Extracted by vision LLM (OCR confidence was ${result.confidence.toFixed(0)})`,
      };
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      logger.warn({ error, documentId }, "Vision LLM fallback failed, keeping OCR result");
      return {
        ...result,
        note: `Vision LLM fallback failed: ${message}. Using OCR result (confidence: ${result.confidence.toFixed(0)}).`,
      };
    }
  }

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
      const ocrResult = await extractor.extract({ bytes, mimeType: document.mimeType ?? "", filename: document.name }, ctx);
      const result = await applyVisionFallback({ userId, documentId, bytes, mimeType: document.mimeType ?? "", result: ocrResult });
      const hasAutoItems = await rulesService.hasAutomaticItems(userId);
      const embeddingModel = await settingsService.get<string>(userId, "ai.model.embedding");
      const hasEmbeddingModel = Boolean(embeddingModel);
      const rulesModel = await settingsService.get<string>(userId, "ai.model.rules");
      const hasSummaryModel = Boolean(rulesModel);
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
            embeddingStatus: hasEmbeddingModel ? "pending" : "done",
            summaryStatus: hasSummaryModel ? "pending" : "done",
            updatedAt: now(),
          },
          tx: txDb,
        });
        if (hasAutoItems) {
          await jobs.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "initial" }, tx: txDb });
        }
        if (hasEmbeddingModel) {
          await jobs.enqueue({ userId, type: "embedding", payload: { documentId, userId }, tx: txDb });
        }
        if (hasSummaryModel) {
          await jobs.enqueue({ userId, type: "summarize", payload: { documentId, userId }, tx: txDb });
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
          ...(isFinalAttempt
            ? {
                ruleStatus: "failed" as const,
                ruleError: "Extraction failed",
                embeddingStatus: "failed" as const,
                embeddingError: "Extraction failed",
                summaryStatus: "failed" as const,
                summaryError: "Extraction failed",
              }
            : {}),
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
