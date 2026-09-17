import { buildModelUri } from "../ai/ai.models.js";
import type { AiService } from "../ai/ai.usecases.js";
import type { Database } from "../database/database.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import type { Document } from "../documents/documents.types.js";
import type { JobHandler } from "../jobs/jobs.runner.js";
import { createLogger, type Logger } from "../../shared/logger/logger.js";
import { parseOrValidationError } from "../../shared/http/validate.js";
import { buildCategoryPaths } from "../tags/tags.models.js";
import { createTagsRepository } from "../tags/tags.repository.js";
import {
  isAppliedResult,
  newEvaluationId,
  nowIso,
  outcomeFor,
  pickCategory,
  PROMPT_WARNING_THRESHOLD,
  resultsForItems,
  findUnknownReplyIds,
  assembleRulesPrompt,
} from "./rules.models.js";
import { createRulesRepository } from "./rules.repository.js";
import { rulesJobPayloadSchema, rulesReplySchema } from "./rules.schemas.js";
import type { AutomaticItem, EvaluationResult, NewSortEvaluation, ReplyItem, RulesJobPayload } from "./rules.types.js";

export function createRulesService({
  db,
  aiService,
  logger = createLogger("rules"),
}: {
  db: Database;
  aiService: AiService;
  logger?: Logger;
}) {
  const repository = createRulesRepository({ db });
  const tagsRepository = createTagsRepository({ db });
  const documentsRepository = createDocumentsRepository({ db });

  async function loadAutomaticItems(userId: string): Promise<{ categories: AutomaticItem[]; tags: AutomaticItem[] }> {
    const [rawCategories, rawTags] = await Promise.all([tagsRepository.listCategoriesRaw(userId), tagsRepository.listTagsRaw(userId)]);
    const paths = buildCategoryPaths(rawCategories);
    const categories: AutomaticItem[] = rawCategories
      .filter((c) => c.autoApply === 1 && c.description.trim().length > 0)
      .map((c) => ({
        type: "category" as const,
        id: c.id,
        name: c.name,
        description: c.description,
        confidenceThreshold: c.confidenceThreshold,
        pathOrName: paths.get(c.id) ?? c.name,
        updatedAt: c.updatedAt,
      }));
    const tags: AutomaticItem[] = rawTags
      .filter((t) => t.autoApply === 1 && t.description.trim().length > 0)
      .map((t) => ({
        type: "tag" as const,
        id: t.id,
        name: t.name,
        description: t.description,
        confidenceThreshold: t.confidenceThreshold,
        pathOrName: t.name,
        updatedAt: t.updatedAt,
      }));
    return { categories, tags };
  }

  async function hasAutomaticItems(userId: string): Promise<boolean> {
    const { categories, tags } = await loadAutomaticItems(userId);
    return categories.length > 0 || tags.length > 0;
  }

  function parseRulesPayload(raw: string): RulesJobPayload {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("Rules job payload is not valid JSON");
    }
    return parseOrValidationError(rulesJobPayloadSchema, value) as RulesJobPayload;
  }

  async function runEvaluation({
    userId,
    documentId,
    targetItems,
    document,
  }: {
    userId: string;
    documentId: string;
    targetItems: AutomaticItem[];
    document: Document;
  }): Promise<{ modelId: string; results: EvaluationResult[] }> {
    const { providerId, model } = await aiService.resolveSlot(userId, "rules");
    const modelId = buildModelUri(providerId, model);
    const { system, input, promptLength } = assembleRulesPrompt({
      documentName: document.name,
      documentText: document.extractedText ?? "",
      categories: targetItems.filter((i) => i.type === "category"),
      tags: targetItems.filter((i) => i.type === "tag"),
    });
    if (promptLength > PROMPT_WARNING_THRESHOLD) {
      logger.warn({ userId, documentId, promptLength }, "Rules prompt exceeds the size warning threshold");
    }
    const { data } = await aiService.generateStructured<{ items: ReplyItem[] }>({
      userId,
      task: "rules",
      schema: rulesReplySchema,
      schemaName: "rules_reply",
      system,
      input,
    });
    const unknownIds = findUnknownReplyIds(targetItems, data.items);
    if (unknownIds.length > 0) {
      logger.warn({ userId, documentId, unknownIds }, "Rules reply referenced unknown ids, dropping them");
    }
    const knownReplyItems = data.items.filter((i) => !unknownIds.includes(i.id));
    return { modelId, results: resultsForItems(targetItems, knownReplyItems) };
  }

  async function applyInitialResults({
    userId,
    documentId,
    jobId,
    modelId,
    results,
    document,
  }: {
    userId: string;
    documentId: string;
    jobId: string;
    modelId: string;
    results: EvaluationResult[];
    document: Document;
  }) {
    const categoryPick = pickCategory(results);
    const now = nowIso();
    const evaluations: NewSortEvaluation[] = results.map((r) => {
      const applied = isAppliedResult(r, categoryPick);
      return {
        id: newEvaluationId(),
        documentId,
        targetType: r.item.type,
        targetId: r.item.id,
        matched: r.matched ? 1 : 0,
        confidence: r.confidence,
        reasoning: r.reasoning,
        outcome: outcomeFor(r, applied),
        proposalKind: null,
        modelId,
        jobId,
        contentHash: document.contentHash,
        evaluatedAt: now,
      };
    });
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Database;
      await repository.insertEvaluations(evaluations, txDb);
      for (const r of results) {
        if (r.item.type !== "tag") continue;
        const applied = isAppliedResult(r, categoryPick);
        if (applied) await repository.setTagAutoApplied({ documentId, tagId: r.item.id, applied: true, tx: txDb });
      }
      if (categoryPick && document.categorySource !== "manual") {
        await documentsRepository.update({
          userId,
          documentId,
          patch: { categoryId: categoryPick.targetId, categorySource: "auto", updatedAt: now },
          tx: txDb,
        });
      }
      await documentsRepository.update({ userId, documentId, patch: { ruleStatus: "done", ruleError: null, updatedAt: now }, tx: txDb });
    });
  }

  const handler: JobHandler = async (job) => {
    const payload = parseRulesPayload(job.payload);
    const document = await documentsRepository.findById({ userId: payload.userId, documentId: payload.documentId });
    if (!document) return;

    if (payload.mode === "initial") {
      const { categories, tags } = await loadAutomaticItems(payload.userId);
      const targetItems = [...categories, ...tags];
      if (targetItems.length === 0) {
        await documentsRepository.update({ userId: payload.userId, documentId: payload.documentId, patch: { ruleStatus: "done", updatedAt: nowIso() } });
        return;
      }
      await documentsRepository.update({
        userId: payload.userId,
        documentId: payload.documentId,
        patch: { ruleStatus: "processing", updatedAt: nowIso() },
      });
      try {
        const { modelId, results } = await runEvaluation({ userId: payload.userId, documentId: payload.documentId, targetItems, document });
        await applyInitialResults({ userId: payload.userId, documentId: payload.documentId, jobId: job.id, modelId, results, document });
      } catch (error) {
        // Spec section 9.1: a provider failure follows the normal retry path and "the
        // document keeps its previous state." Reverting to pending (not failed) means
        // Inbox still shows it correctly and the job's own retry can pick it up again.
        await documentsRepository.update({
          userId: payload.userId,
          documentId: payload.documentId,
          patch: { ruleStatus: "pending", updatedAt: nowIso() },
        });
        throw error;
      }
      return;
    }
    // Rerun mode is added in Task 4.
  };

  return { handler, hasAutomaticItems };
}

export type RulesService = ReturnType<typeof createRulesService>;
