// Informed by papra's job-handler-plus-status-column pattern: a background job owns a
// status column on the row it works on and never leaves that column mid-flight.
import { createError } from "../../shared/errors/errors.js";
import { createLogger, type Logger } from "../../shared/logger/logger.js";
import { parseOrValidationError } from "../../shared/http/validate.js";
import type { AiService } from "../ai/ai.usecases.js";
import { asTxDb, type Database } from "../database/database.js";
import { nowIso, sanitizeFilename } from "../documents/documents.models.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import { normalizeFieldRows } from "../fields/fields.models.js";
import { createFieldsRepository } from "../fields/fields.repository.js";
import { createJobsService } from "../jobs/jobs.usecases.js";
import type { JobHandler } from "../jobs/jobs.runner.js";
import { assembleSummaryPrompt } from "./summary.models.js";
import { summaryJobPayloadSchema, summaryReplySchema } from "./summary.schemas.js";
import type { SummaryResult } from "./summary.types.js";

function documentNotFound(documentId: string) {
  return createError({ code: "documents.not_found", message: `Document "${documentId}" not found`, status: 404 });
}

export function createSummaryService({
  db,
  aiService,
  logger = createLogger("summary"),
}: {
  db: Database;
  aiService: Pick<AiService, "generateStructured">;
  logger?: Logger;
}) {
  const documentsRepository = createDocumentsRepository({ db });
  const fieldsRepository = createFieldsRepository({ db });
  const jobs = createJobsService({ db });

  function parseSummaryPayload(raw: string) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw createError({ code: "summary.invalid_payload", message: "Summarize job payload is not valid JSON", status: 500 });
    }
    return parseOrValidationError(summaryJobPayloadSchema, value);
  }

  async function getEnrichedOrThrow(userId: string, documentId: string) {
    const row = await documentsRepository.findByIdWithExtras({ userId, documentId });
    if (!row) throw documentNotFound(documentId);
    return row;
  }

  const handler: JobHandler = async (job) => {
    const { documentId, userId } = parseSummaryPayload(job.payload);
    const document = await documentsRepository.findById({ userId, documentId });
    if (!document) return; // Deleted between enqueue and execution.

    const text = document.extractedText ?? "";
    if (text.trim().length === 0) {
      // Nothing to summarize: mark done without calling the model.
      await documentsRepository.update({
        userId,
        documentId,
        patch: { summaryStatus: "done", summaryError: null, updatedAt: nowIso() },
      });
      return;
    }

    await documentsRepository.update({ userId, documentId, patch: { summaryStatus: "processing", updatedAt: nowIso() } });

    try {
      const { system, input } = assembleSummaryPrompt({ documentName: document.name, documentText: text });
      const { data } = await aiService.generateStructured<SummaryResult>({
        userId,
        task: "rules",
        schema: summaryReplySchema,
        schemaName: "summary_reply",
        system,
        input,
      });
      const { fields, dropped } = normalizeFieldRows(data.fields ?? []);
      if (dropped.length > 0) {
        logger.debug({ userId, documentId, dropped }, "Dropped smart field rows the model got wrong");
      }
      // One transaction so a document is never seen with a new summary and stale fields.
      await db.transaction(async (tx) => {
        const txDb = asTxDb(tx);
        await documentsRepository.update({
          userId,
          documentId,
          patch: {
            summary: data.summary,
            suggestedTitle: data.suggestedTitle,
            documentDate: data.documentDate,
            summaryStatus: "done",
            summaryError: null,
            updatedAt: nowIso(),
          },
          tx: txDb,
        });
        await fieldsRepository.replaceForDocument({ userId, documentId, fields, tx: txDb });
      });
    } catch (error) {
      const message = ((error as Error).message ?? String(error)).slice(0, 2000);
      logger.warn({ userId, documentId, err: message }, "Summarize job failed");
      // Reverts to pending, not failed, same as the rules handler: the document keeps
      // its previous state and the job's own retry can pick it up again.
      await documentsRepository.update({
        userId,
        documentId,
        patch: { summaryStatus: "pending", summaryError: message, updatedAt: nowIso() },
      });
      throw error;
    }
  };

  async function acceptTitle({ userId, documentId }: { userId: string; documentId: string }) {
    const document = await documentsRepository.findById({ userId, documentId });
    if (!document) throw documentNotFound(documentId);
    if (!document.suggestedTitle) return getEnrichedOrThrow(userId, documentId);

    await documentsRepository.update({
      userId,
      documentId,
      patch: { name: sanitizeFilename(document.suggestedTitle), suggestedTitle: null, updatedAt: nowIso() },
    });
    return getEnrichedOrThrow(userId, documentId);
  }

  return { handler, acceptTitle };
}

export type SummaryService = ReturnType<typeof createSummaryService>;
