import { buildModelUri } from "../ai/ai.models.js";
import type { AiService } from "../ai/ai.usecases.js";
import { asTxDb, type Database } from "../database/database.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import type { DocumentsService } from "../documents/documents.usecases.js";
import type { Document } from "../documents/documents.types.js";
import type { JobHandler } from "../jobs/jobs.runner.js";
import { createJobsService } from "../jobs/jobs.usecases.js";
import { createError } from "../../shared/errors/errors.js";
import { createLogger, type Logger } from "../../shared/logger/logger.js";
import { parseOrValidationError } from "../../shared/http/validate.js";
import { buildCategoryPaths } from "../tags/tags.models.js";
import { createTagsRepository } from "../tags/tags.repository.js";
import {
  assembleRulesPrompt,
  deriveRerunOutcome,
  findUnknownReplyIds,
  isAppliedResult,
  isDismissedProposalStillSame,
  newEvaluationId,
  nowIso,
  outcomeFor,
  parseScope,
  pickCategory,
  PROMPT_WARNING_THRESHOLD,
  resultsForItems,
} from "./rules.models.js";
import { createRulesRepository } from "./rules.repository.js";
import { rulesJobPayloadSchema, rulesReplySchema } from "./rules.schemas.js";
import type { AutomaticItem, EvaluationResult, NewSortEvaluation, Proposal, ProposalKind, ReplyItem, RulesJobPayload, TargetType } from "./rules.types.js";

export function createRulesService({
  db,
  aiService,
  documentsService,
  logger = createLogger("rules"),
}: {
  db: Database;
  aiService: AiService;
  documentsService: DocumentsService;
  logger?: Logger;
}) {
  const repository = createRulesRepository({ db });
  const tagsRepository = createTagsRepository({ db });
  const documentsRepository = createDocumentsRepository({ db });
  const jobsService = createJobsService({ db });

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

  function tagNotFound(tagId: string) {
    return createError({ code: "tags.not_found", message: `Tag "${tagId}" not found`, status: 404 });
  }
  function categoryNotFound(categoryId: string) {
    return createError({ code: "categories.not_found", message: `Category "${categoryId}" not found`, status: 404 });
  }

  async function loadSingleItem(userId: string, targetType: TargetType, targetId: string): Promise<AutomaticItem | null> {
    if (targetType === "tag") {
      const tag = await tagsRepository.findTagById({ userId, tagId: targetId });
      if (!tag) return null;
      return { type: "tag", id: tag.id, name: tag.name, description: tag.description, confidenceThreshold: tag.confidenceThreshold, pathOrName: tag.name, updatedAt: tag.updatedAt };
    }
    const category = await tagsRepository.findCategoryById({ userId, categoryId: targetId });
    if (!category) return null;
    const paths = buildCategoryPaths(await tagsRepository.listCategoriesRaw(userId));
    return {
      type: "category",
      id: category.id,
      name: category.name,
      description: category.description,
      confidenceThreshold: category.confidenceThreshold,
      pathOrName: paths.get(category.id) ?? category.name,
      updatedAt: category.updatedAt,
    };
  }

  async function requireTag(userId: string, tagId: string) {
    const tag = await tagsRepository.findTagById({ userId, tagId });
    if (!tag) throw tagNotFound(tagId);
    return tag;
  }

  async function requireCategory(userId: string, categoryId: string) {
    const category = await tagsRepository.findCategoryById({ userId, categoryId });
    if (!category) throw categoryNotFound(categoryId);
    return category;
  }

  async function resolveScopeDocuments(userId: string, scope: string) {
    const parsed = parseScope(scope);
    if (parsed.kind === "needs_review") return documentsRepository.listByUser({ userId, view: "needs_review" });
    if (parsed.kind === "category") return documentsRepository.listByUser({ userId, categoryId: parsed.categoryId, view: "all" });
    return documentsRepository.listByUser({ userId, view: "all" });
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
      const txDb = asTxDb(tx);
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

  async function applyRerunResults({
    documentId,
    jobId,
    modelId,
    results,
    document,
  }: {
    documentId: string;
    jobId: string;
    modelId: string;
    results: EvaluationResult[];
    document: Document;
  }) {
    const categoryPick = pickCategory(results.filter((r) => r.item.type === "category"));
    const now = nowIso();
    await db.transaction(async (tx) => {
      const txDb = asTxDb(tx);
      const evaluations: NewSortEvaluation[] = [];
      for (const r of results) {
        const applied = isAppliedResult(r, categoryPick);
        let currentlyAuto = false;
        let currentlyManual = false;
        if (r.item.type === "tag") {
          const chip = await repository.findDocumentTag({ documentId, tagId: r.item.id, tx: txDb });
          currentlyAuto = chip?.appliedByAuto === 1;
          currentlyManual = chip?.appliedByManual === 1;
        }
        const { outcome, proposalKind } = deriveRerunOutcome({
          result: r,
          applied,
          currentlyAuto,
          currentlyManual,
          currentCategoryId: document.categoryId,
          currentCategorySource: document.categorySource as "manual" | "auto" | null,
        });
        let finalOutcome = outcome;
        if (proposalKind) {
          const dismissed = await repository.findLastDismissed({ documentId, targetType: r.item.type, targetId: r.item.id, proposalKind, tx: txDb });
          if (
            dismissed &&
            isDismissedProposalStillSame({
              dismissedEvaluatedAt: dismissed.evaluatedAt,
              dismissedContentHash: dismissed.contentHash,
              itemUpdatedAt: r.item.updatedAt,
              documentContentHash: document.contentHash,
            })
          ) {
            finalOutcome = "dismissed";
          }
        }
        evaluations.push({
          id: newEvaluationId(),
          documentId,
          targetType: r.item.type,
          targetId: r.item.id,
          matched: r.matched ? 1 : 0,
          confidence: r.confidence,
          reasoning: r.reasoning,
          outcome: finalOutcome,
          proposalKind: proposalKind,
          modelId,
          jobId,
          contentHash: document.contentHash,
          evaluatedAt: now,
        });
      }
      await repository.insertEvaluations(evaluations, txDb);
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

    // Rerun mode: nothing is applied to the document directly (spec section 9.4); the
    // job never touches rule_status either (decision 14), so no processing/pending
    // bookkeeping is needed here, only the evaluation rows.
    let targetItems: AutomaticItem[];
    if (payload.targetType && payload.targetId) {
      const single = await loadSingleItem(payload.userId, payload.targetType, payload.targetId);
      if (!single) {
        logger.warn({ documentId: payload.documentId, targetType: payload.targetType, targetId: payload.targetId }, "Rerun target no longer exists, skipping");
        return;
      }
      targetItems = [single];
    } else {
      const { categories, tags } = await loadAutomaticItems(payload.userId);
      targetItems = [...categories, ...tags];
    }
    if (targetItems.length === 0) return;
    const { modelId, results } = await runEvaluation({ userId: payload.userId, documentId: payload.documentId, targetItems, document });
    await applyRerunResults({ documentId: payload.documentId, jobId: job.id, modelId, results, document });
  };

  async function requestSort({ userId, documentId }: { userId: string; documentId: string }) {
    await documentsService.get({ userId, documentId });
    return jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "rerun" } });
  }

  async function runOnScope({ userId, targetType, targetId, scope }: { userId: string; targetType: TargetType; targetId: string; scope: string }) {
    if (targetType === "tag") await requireTag(userId, targetId);
    else await requireCategory(userId, targetId);
    const documents = await resolveScopeDocuments(userId, scope);
    const jobIds: string[] = [];
    for (const doc of documents) {
      const job = await jobsService.enqueue({ userId, type: "rules", payload: { documentId: doc.id, userId, mode: "rerun", targetType, targetId } });
      jobIds.push(job.id);
    }
    return { count: documents.length, jobIds };
  }

  async function countForScope({ userId, scope }: { userId: string; scope: string }) {
    const documents = await resolveScopeDocuments(userId, scope);
    return documents.length;
  }

  async function dryRun({
    userId,
    documentId,
    targetType,
    name,
    description,
    threshold,
  }: {
    userId: string;
    documentId: string;
    targetType: TargetType;
    name: string;
    description: string;
    threshold: number;
  }) {
    const document = await documentsService.get({ userId, documentId });
    const draftItem: AutomaticItem = { type: targetType, id: "draft", name, description, confidenceThreshold: threshold, pathOrName: name, updatedAt: nowIso() };
    const { modelId: _modelId, results } = await runEvaluation({
      userId,
      documentId,
      targetItems: [draftItem],
      document,
    });
    const [result] = results;
    const wouldApply = result ? result.matched && result.confidence >= threshold : false;
    return {
      matched: result?.matched ?? false,
      confidence: result?.confidence ?? 0,
      reasoning: result?.reasoning ?? "No match returned by the model.",
      wouldApply,
    };
  }

  async function enrichProposals(userId: string, rows: { id: string; documentId: string; targetType: string; targetId: string; confidence: number; reasoning: string; proposalKind: string | null; documentName: string }[]): Promise<Proposal[]> {
    const [tags, categories] = await Promise.all([tagsRepository.listTagsRaw(userId), tagsRepository.listCategoriesRaw(userId)]);
    const paths = buildCategoryPaths(categories);
    const tagNames = new Map(tags.map((t) => [t.id, t.name]));
    return rows.map((r) => ({
      id: r.id,
      documentId: r.documentId,
      documentName: r.documentName,
      targetType: r.targetType as TargetType,
      targetId: r.targetId,
      itemName: r.targetType === "tag" ? (tagNames.get(r.targetId) ?? "(deleted tag)") : (paths.get(r.targetId) ?? "(deleted category)"),
      kind: r.proposalKind as ProposalKind,
      confidence: r.confidence,
      reasoning: r.reasoning,
    }));
  }

  async function listProposalsForDocument({ userId, documentId }: { userId: string; documentId: string }) {
    await documentsService.get({ userId, documentId });
    const rows = await repository.listProposedForDocument({ userId, documentId });
    return enrichProposals(userId, rows);
  }

  async function listProposals({ userId, limit = 50, cursor }: { userId: string; limit?: number; cursor?: string }) {
    const rows = await repository.listProposedForUser(userId);
    const startIndex = cursor ? rows.findIndex((r) => r.id === cursor) + 1 : 0;
    const page = rows.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < rows.length ? (page[page.length - 1]?.id ?? null) : null;
    return { proposals: await enrichProposals(userId, page), nextCursor };
  }

  async function applyProposals({ userId, accept, dismiss }: { userId: string; accept: string[]; dismiss: string[] }) {
    const acceptRows = await repository.findProposalsByIds({ userId, ids: accept });
    const dismissRows = await repository.findProposalsByIds({ userId, ids: dismiss });
    const now = nowIso();
    await db.transaction(async (tx) => {
      const txDb = asTxDb(tx);
      for (const row of acceptRows) {
        if (row.targetType === "tag" && row.proposalKind === "add_tag") {
          await repository.setTagAutoApplied({ documentId: row.documentId, tagId: row.targetId, applied: true, tx: txDb });
        } else if (row.targetType === "tag" && row.proposalKind === "remove_tag") {
          await repository.setTagAutoApplied({ documentId: row.documentId, tagId: row.targetId, applied: false, tx: txDb });
        } else if (row.targetType === "category" && row.proposalKind === "set_category") {
          await documentsRepository.update({ userId, documentId: row.documentId, patch: { categoryId: row.targetId, categorySource: "auto", updatedAt: now }, tx: txDb });
        }
        await repository.updateEvaluationOutcome({ id: row.id, outcome: "applied", tx: txDb });
      }
      for (const row of dismissRows) {
        await repository.updateEvaluationOutcome({ id: row.id, outcome: "dismissed", tx: txDb });
      }
    });
    return { appliedCount: acceptRows.length, dismissedCount: dismissRows.length };
  }

  return {
    handler,
    hasAutomaticItems,
    requestSort,
    runOnScope,
    countForScope,
    dryRun,
    listProposalsForDocument,
    listProposals,
    applyProposals,
  };
}

export type RulesService = ReturnType<typeof createRulesService>;
