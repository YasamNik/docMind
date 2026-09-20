import type { Readable } from "node:stream";
import { LibsqlError } from "@libsql/client";
import { createError } from "../../shared/errors/errors.js";
import { createLogger, type Logger } from "../../shared/logger/logger.js";
import { parseOrValidationError } from "../../shared/http/validate.js";
import type { Database } from "../database/database.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import type { DocumentsService } from "../documents/documents.usecases.js";
import type { AiService } from "../ai/ai.usecases.js";
import type { ImageInput } from "../ai/ai.types.js";
import type { JobHandler } from "../jobs/jobs.runner.js";
import { createJobsService } from "../jobs/jobs.usecases.js";
import type { StorageService } from "../storage/storage.usecases.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import {
  assembleReceiptPrompt,
  BUDGET_CATEGORY_PRESETS,
  MAX_RECEIPT_PAGES,
  newBudgetCategoryId,
  newBudgetReceiptId,
  newBudgetReceiptItemId,
  normalizeReceiptReply,
  nowIso,
} from "./budget.models.js";
import { createBudgetRepository } from "./budget.repository.js";
import { budgetReceiptReplySchema, receiptJobPayloadSchema, type RawBudgetReceiptReply } from "./budget.schemas.js";
import type { BudgetReceipt, NewBudgetCategory, NewBudgetReceiptItem } from "./budget.types.js";

function isUniqueConstraintError(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof LibsqlError && cause.code === "SQLITE_CONSTRAINT";
}

async function readAllToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// Only the job types the ordinary upload pipeline enqueues once extraction finishes.
// Extraction itself is never cancelled: local OCR runs on every page regardless, since
// it costs nothing (spec section 5 / risks).
const CANCELABLE_JOB_TYPES = new Set(["rules", "summarize", "embedding"]);

export function createBudgetService({
  db,
  settingsService,
  aiService,
  documentsService,
  storageService,
  logger = createLogger("budget"),
}: {
  db: Database;
  settingsService: Pick<SettingsService, "get" | "setInternal">;
  aiService: Pick<AiService, "generateStructuredFromImages">;
  documentsService: Pick<DocumentsService, "remove">;
  storageService: Pick<StorageService, "getDriver">;
  logger?: Logger;
}) {
  const repository = createBudgetRepository({ db });
  const documentsRepository = createDocumentsRepository({ db });
  const jobsService = createJobsService({ db });

  function buildPresetCategory(userId: string, preset: { name: string; description: string }): NewBudgetCategory {
    const t = nowIso();
    return {
      id: newBudgetCategoryId(),
      userId,
      name: preset.name,
      description: preset.description,
      color: null,
      autoApply: 1,
      createdAt: t,
      updatedAt: t,
    };
  }

  // Not called at server start, same reasoning as tags.usecases.ts's ensureTypesSeeded: a
  // fresh install has no user at boot. Callers pass a real userId, and the intended call
  // site is the receipt job handler, right before the categorisation prompt is built.
  async function ensureCategoriesSeeded({ userId }: { userId: string }) {
    const done = await settingsService.get<boolean>(userId, "budget.categoriesSeeded");
    if (done) return;

    // Inserted one at a time, not as a batch, so a crash partway through leaves a retry
    // able to finish: the guard flag cannot commit in the same transaction as these rows
    // because the settings repository takes no tx. A name the user already owns is
    // skipped, never overwritten.
    for (const preset of BUDGET_CATEGORY_PRESETS) {
      try {
        await repository.insertCategory(buildPresetCategory(userId, preset));
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          logger.info({ userId, name: preset.name }, "Preset budget category skipped, the name is already taken");
          continue;
        }
        throw error;
      }
    }

    await settingsService.setInternal(userId, "budget.categoriesSeeded", true);
  }

  function receiptNotFound(receiptId: string) {
    return createError({ code: "budget.receipt_not_found", message: `Receipt "${receiptId}" not found`, status: 404 });
  }
  function categoryNotFound(categoryId: string) {
    return createError({ code: "budget.category_not_found", message: `Budget category "${categoryId}" not found`, status: 404 });
  }
  function itemNotFound(itemId: string) {
    return createError({ code: "budget.item_not_found", message: `Receipt item "${itemId}" not found`, status: 404 });
  }
  function categoryDuplicateName() {
    return createError({ code: "budget.category_duplicate_name", message: "A budget category with this name already exists", status: 409 });
  }

  async function requireCategory(userId: string, categoryId: string) {
    const category = await repository.findCategoryById({ userId, categoryId });
    if (!category) throw categoryNotFound(categoryId);
    return category;
  }

  // Reads straight from the document's own storage driver, the same reasoning as
  // extraction.usecases.ts's openDocumentFile: this is background upkeep, not the
  // user-facing file read, so it must keep working whatever storage the page sits on.
  async function openDocumentFile({ userId, documentId }: { userId: string; documentId: string }) {
    const document = await documentsRepository.findById({ userId, documentId });
    if (!document || document.deletedAt) {
      throw createError({ code: "documents.not_found", message: `Document "${documentId}" not found`, status: 404 });
    }
    const driver = await storageService.getDriver(userId, document.storageDriver);
    const stream = await driver.get({ key: document.storageKey });
    return { document, stream };
  }

  // Best effort, deliberately not airtight: the runner can already have claimed a child
  // page's rules, summarize, or embedding job in the few seconds between its own upload
  // and this call, in which case that page keeps the full ordinary pipeline anyway. That
  // is a miss on cost, not on correctness (spec section 5 and its risks section). Kept
  // inside the budget module rather than touching the shared upload or extraction path.
  async function cancelChildPagePipeline({ userId, childDocumentIds }: { userId: string; childDocumentIds: string[] }) {
    if (childDocumentIds.length === 0) return;
    const childSet = new Set(childDocumentIds);
    const pendingJobs = await jobsService.list({ userId, status: "pending" });
    const now = nowIso();
    for (const job of pendingJobs) {
      if (!CANCELABLE_JOB_TYPES.has(job.type)) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(job.payload);
      } catch {
        continue;
      }
      const documentId = (payload as { documentId?: unknown }).documentId;
      if (typeof documentId === "string" && childSet.has(documentId)) {
        await jobsService.repository.markDone({ id: job.id, finishedAt: now });
      }
    }
    for (const documentId of childDocumentIds) {
      await documentsRepository.update({
        userId,
        documentId,
        patch: { ruleStatus: "done", embeddingStatus: "done", summaryStatus: "done", updatedAt: now },
      });
    }
  }

  async function createReceipt({ userId, documentIds }: { userId: string; documentIds: string[] }): Promise<{ receipt: BudgetReceipt; alreadyExisted: boolean }> {
    if (documentIds.length === 0) {
      throw createError({ code: "budget.no_pages", message: "A receipt needs at least one page", status: 400 });
    }
    if (documentIds.length > MAX_RECEIPT_PAGES) {
      throw createError({
        code: "budget.too_many_pages",
        message: `A receipt can have at most ${MAX_RECEIPT_PAGES} pages, got ${documentIds.length}.`,
        status: 400,
      });
    }

    const pageOneId = documentIds[0]!;
    const existing = await repository.findReceiptByDocumentId({ userId, documentId: pageOneId });
    if (existing) return { receipt: existing, alreadyExisted: true };

    const documents = [];
    for (const documentId of documentIds) {
      const document = await documentsRepository.findById({ userId, documentId });
      if (!document || document.deletedAt) {
        throw createError({ code: "documents.not_found", message: `Document "${documentId}" not found`, status: 404 });
      }
      documents.push(document);
    }

    const t = nowIso();
    // Typed as the select shape, not the insert shape: every field below is a concrete
    // literal, and the function returns this same value as the created receipt, which
    // needs every column present rather than the insert type's optional nullable columns.
    const receipt: BudgetReceipt = {
      id: newBudgetReceiptId(),
      userId,
      documentId: pageOneId,
      merchant: null,
      categoryId: null,
      purchasedAt: null,
      currency: null,
      total: null,
      taxAmount: null,
      status: "pending",
      note: null,
      duplicateOfReceiptId: null,
      createdAt: t,
      updatedAt: t,
    };

    try {
      await repository.insertReceiptWithItems({ receipt, items: [] });
    } catch (error) {
      // The unique index on (user_id, document_id): a second receipt on the same page 1
      // is a conflict, not a new row. This only fires on a genuine race, since the check
      // above already covers the ordinary case.
      if (isUniqueConstraintError(error)) {
        const raceExisting = await repository.findReceiptByDocumentId({ userId, documentId: pageOneId });
        if (raceExisting) return { receipt: raceExisting, alreadyExisted: true };
      }
      throw error;
    }

    // Pages two and later hang off page one the same way a mail attachment hangs off
    // its mail (spec section 1): this is what gives "delete this one" on a duplicate a
    // document subtree to trash, and what the library's own related-documents panel
    // reads. A page that already has some other parent (unexpected, but not this
    // module's call to override) is left alone.
    for (const [index, documentId] of documentIds.slice(1).entries()) {
      const child = documents[index + 1]!;
      if (!child.parentDocumentId) {
        await documentsRepository.update({ userId, documentId, patch: { parentDocumentId: pageOneId, updatedAt: nowIso() } });
      }
    }

    // Right away, not from inside the job: the job still has to read every photo and
    // wait on the vision call, which only widens the race the cancellation is trying to
    // win against a child page's own extraction finishing first.
    await cancelChildPagePipeline({ userId, childDocumentIds: documentIds.slice(1) });

    await jobsService.enqueue({ userId, type: "receipt", payload: { receiptId: receipt.id, userId, documentIds } });
    return { receipt, alreadyExisted: false };
  }

  function parseReceiptPayload(raw: string) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw createError({ code: "budget.invalid_payload", message: "Receipt job payload is not valid JSON", status: 500 });
    }
    return parseOrValidationError(receiptJobPayloadSchema, value);
  }

  const handler: JobHandler = async (job) => {
    const payload = parseReceiptPayload(job.payload);
    const receipt = await repository.findReceiptById({ userId: payload.userId, receiptId: payload.receiptId });
    if (!receipt) return; // Deleted between enqueue and run.

    try {
      // Lazy, per user, right before the prompt needs the list: same precedent as
      // rules.usecases.ts calling tagsService.ensureTypesSeeded right before its prompt.
      await ensureCategoriesSeeded({ userId: payload.userId });
      const rawCategories = await repository.listCategoriesRaw(payload.userId);
      const categories = rawCategories.filter((c) => c.autoApply === 1 && c.description.trim().length > 0);

      const images: ImageInput[] = [];
      for (const documentId of payload.documentIds) {
        const { document, stream } = await openDocumentFile({ userId: payload.userId, documentId });
        const data = await readAllToBuffer(stream);
        images.push({ data, mimeType: document.mimeType || "image/jpeg" });
      }

      const { system } = assembleReceiptPrompt({ categories });
      const { data } = await aiService.generateStructuredFromImages<RawBudgetReceiptReply>({
        userId: payload.userId,
        images,
        schema: budgetReceiptReplySchema,
        schemaName: "budget_receipt_reply",
        system,
      });

      const normalized = normalizeReceiptReply({ reply: data, categories });
      const now = nowIso();

      if (normalized.failed) {
        await repository.updateReceipt({ userId: payload.userId, receiptId: receipt.id, patch: { status: "failed", note: normalized.note, updatedAt: now } });
        return;
      }

      let duplicateOfReceiptId: string | null = null;
      let status = normalized.status;
      if (normalized.merchant && normalized.purchasedAt && normalized.total !== null && normalized.currency) {
        const duplicate = await repository.findDuplicate({
          userId: payload.userId,
          merchant: normalized.merchant,
          purchasedAt: normalized.purchasedAt,
          total: normalized.total,
          currency: normalized.currency,
          excludeReceiptId: receipt.id,
        });
        if (duplicate) {
          duplicateOfReceiptId = duplicate.id;
          status = "needs_review";
        }
      }

      const items: NewBudgetReceiptItem[] = normalized.items.map((item, index) => ({
        id: newBudgetReceiptItemId(),
        userId: payload.userId,
        receiptId: receipt.id,
        lineNumber: index + 1,
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: item.amount,
        categoryId: item.categoryId,
        categorySource: item.categorySource,
        confidence: item.confidence,
        createdAt: now,
        updatedAt: now,
      }));

      await repository.updateReceiptWithItems({
        userId: payload.userId,
        receiptId: receipt.id,
        patch: {
          merchant: normalized.merchant,
          purchasedAt: normalized.purchasedAt,
          currency: normalized.currency,
          total: normalized.total,
          taxAmount: normalized.taxAmount,
          categoryId: normalized.categoryId,
          status,
          note: normalized.note,
          duplicateOfReceiptId,
          updatedAt: now,
        },
        items,
      });
    } catch (error) {
      // budget_receipts has no "processing" status, so the row simply stays "pending"
      // through every attempt, which is the correct state for the job runner's own
      // retry to pick back up. Only once retries are exhausted is it worth writing
      // "failed" so the receipt does not spin forever after the job gives up.
      if (job.attempts >= job.maxAttempts) {
        const message = ((error as Error).message ?? String(error)).slice(0, 2000);
        await repository.updateReceipt({ userId: payload.userId, receiptId: receipt.id, patch: { status: "failed", note: message, updatedAt: nowIso() } });
      }
      throw error;
    }
  };

  async function getReceipt({ userId, receiptId }: { userId: string; receiptId: string }) {
    const receipt = await repository.findReceiptWithItems({ userId, receiptId });
    if (!receipt) throw receiptNotFound(receiptId);
    return receipt;
  }

  async function listMonth({ userId, month }: { userId: string; month: string }) {
    return repository.listMonthReceiptsWithItems({ userId, month });
  }

  async function updateReceiptFields({
    userId,
    receiptId,
    patch,
  }: {
    userId: string;
    receiptId: string;
    patch: {
      merchant?: string | null;
      purchasedAt?: string | null;
      currency?: string | null;
      total?: number | null;
      taxAmount?: number | null;
      categoryId?: string | null;
    };
  }) {
    await getReceipt({ userId, receiptId });
    if (patch.categoryId) await requireCategory(userId, patch.categoryId);
    await repository.updateReceipt({ userId, receiptId, patch: { ...patch, updatedAt: nowIso() } });
    return getReceipt({ userId, receiptId });
  }

  async function updateReceiptItemCategory({
    userId,
    receiptId,
    itemId,
    categoryId,
  }: {
    userId: string;
    receiptId: string;
    itemId: string;
    categoryId: string | null;
  }) {
    const item = await repository.findReceiptItemById({ userId, itemId });
    if (!item || item.receiptId !== receiptId) throw itemNotFound(itemId);
    if (categoryId) await requireCategory(userId, categoryId);
    // A correction is a correction, not training (spec section 7): manual never gets
    // overwritten by a later re-read, and it carries no model confidence of its own.
    await repository.updateReceiptItem({
      userId,
      itemId,
      patch: { categoryId, categorySource: categoryId ? "manual" : null, confidence: null, updatedAt: nowIso() },
    });
    return getReceipt({ userId, receiptId });
  }

  async function resolveDuplicate({ userId, receiptId, action }: { userId: string; receiptId: string; action: "keep" | "delete" }) {
    const receipt = await repository.findReceiptById({ userId, receiptId });
    if (!receipt) throw receiptNotFound(receiptId);
    if (!receipt.duplicateOfReceiptId) {
      throw createError({ code: "budget.not_a_duplicate", message: "This receipt is not flagged as a possible duplicate", status: 400 });
    }

    if (action === "delete") {
      // Never delete just the record: the document (and, through it, any child pages)
      // moves to trash the same way removing any other document does. Nothing here
      // purges storage.
      await documentsService.remove({ userId, documentId: receipt.documentId });
      await repository.deleteReceipt({ userId, receiptId });
      return { deleted: true as const };
    }

    // "Keep both" clears the flag. When nothing else was recorded against this receipt
    // (no note), it goes back to ready; otherwise it stays under review for that other
    // reason, which resolving a duplicate does not address.
    const status = receipt.note ? "needs_review" : "ready";
    await repository.updateReceipt({ userId, receiptId, patch: { duplicateOfReceiptId: null, status, updatedAt: nowIso() } });
    return { receipt: await getReceipt({ userId, receiptId }) };
  }

  async function listCategories({ userId }: { userId: string }) {
    await ensureCategoriesSeeded({ userId });
    return repository.listCategoriesRaw(userId);
  }

  async function createCategory({
    userId,
    name,
    description = "",
    color = null,
    autoApply = true,
  }: {
    userId: string;
    name: string;
    description?: string;
    color?: string | null;
    autoApply?: boolean;
  }) {
    const t = nowIso();
    const category: NewBudgetCategory = {
      id: newBudgetCategoryId(),
      userId,
      name,
      description,
      color,
      autoApply: autoApply ? 1 : 0,
      createdAt: t,
      updatedAt: t,
    };
    try {
      await repository.insertCategory(category);
    } catch (error) {
      if (isUniqueConstraintError(error)) throw categoryDuplicateName();
      throw error;
    }
    return category;
  }

  async function updateCategory({
    userId,
    categoryId,
    patch,
  }: {
    userId: string;
    categoryId: string;
    patch: { name?: string; description?: string; color?: string | null; autoApply?: boolean };
  }) {
    await requireCategory(userId, categoryId);
    const dbPatch: Partial<NewBudgetCategory> = { updatedAt: nowIso() };
    if (patch.name !== undefined) dbPatch.name = patch.name;
    if (patch.description !== undefined) dbPatch.description = patch.description;
    if (patch.color !== undefined) dbPatch.color = patch.color;
    if (patch.autoApply !== undefined) dbPatch.autoApply = patch.autoApply ? 1 : 0;
    try {
      await repository.updateCategory({ userId, categoryId, patch: dbPatch });
    } catch (error) {
      if (isUniqueConstraintError(error)) throw categoryDuplicateName();
      throw error;
    }
    return requireCategory(userId, categoryId);
  }

  async function deleteCategory({ userId, categoryId }: { userId: string; categoryId: string }) {
    await requireCategory(userId, categoryId);
    // Both budget_categories foreign keys (a receipt's own category_id and its items')
    // are ON DELETE SET NULL, so there is no auto-sourced document link to clear the
    // way tags.usecases.ts's deleteType has to.
    await repository.deleteCategory({ userId, categoryId });
  }

  return {
    ensureCategoriesSeeded,
    createReceipt,
    handler,
    getReceipt,
    listMonth,
    updateReceiptFields,
    updateReceiptItemCategory,
    resolveDuplicate,
    listCategories,
    createCategory,
    updateCategory,
    deleteCategory,
  };
}

export type BudgetService = ReturnType<typeof createBudgetService>;
