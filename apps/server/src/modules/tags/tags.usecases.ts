import { LibsqlError } from "@libsql/client";
import { createError } from "../../shared/errors/errors.js";
import { createLogger, type Logger } from "../../shared/logger/logger.js";
import { asTxDb, type Database } from "../database/database.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import { createRulesRepository } from "../rules/rules.repository.js";
import type { AiService } from "../ai/ai.usecases.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import {
  buildCategoryPaths,
  buildDescriptionAssistantPrompt,
  descriptionAssistantLimit,
  DOCUMENT_TYPE_PRESETS,
  newCategoryId,
  newDocumentTypeId,
  newTagId,
  nextSortOrder,
  normalizeName,
  nowIso,
  RETIRED_TYPE_VALUE_MAP,
  sortByNameCI,
  sortCategories,
  trimDescriptionSuggestion,
  wouldCreateCycle,
} from "./tags.models.js";
import { descriptionAssistantReplySchema } from "./tags.schemas.js";
import { createTagsRepository } from "./tags.repository.js";
import type {
  Category,
  CategoryWithMeta,
  DocumentType,
  DocumentTypeWithCount,
  NewCategory,
  NewDocumentType,
  NewTag,
  Tag,
  TagChip,
  TagWithCount,
} from "./tags.types.js";

function isUniqueConstraintError(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof LibsqlError && cause.code === "SQLITE_CONSTRAINT";
}

function tagNotFound(tagId: string) {
  return createError({ code: "tags.not_found", message: `Tag "${tagId}" not found`, status: 404 });
}
function tagDuplicateName() {
  return createError({ code: "tags.duplicate_name", message: "A tag with this name already exists", status: 409 });
}
function categoryNotFound(categoryId: string) {
  return createError({ code: "categories.not_found", message: `Category "${categoryId}" not found`, status: 404 });
}
function categoryDuplicateName() {
  return createError({ code: "categories.duplicate_name", message: "A category with this name already exists under the same parent", status: 409 });
}
function categoryInvalidParent() {
  return createError({ code: "categories.invalid_parent", message: "That parent category is not valid", status: 400 });
}
function documentNotFound(documentId: string) {
  return createError({ code: "documents.not_found", message: `Document "${documentId}" not found`, status: 404 });
}
function typeNotFound(typeId: string) {
  return createError({ code: "types.not_found", message: `Document type "${typeId}" not found`, status: 404 });
}
function typeDuplicateName() {
  return createError({ code: "types.duplicate_name", message: "A document type with this name already exists", status: 409 });
}

type TagPatch = { name?: string; color?: string | null; description?: string; confidenceThreshold?: number; autoApply?: boolean };
type CategoryPatch = TagPatch & { parentId?: string | null; sortOrder?: number };
type TypePatch = TagPatch;

export function createTagsService({
  db,
  aiService,
  settingsService,
  logger = createLogger("tags"),
}: {
  db: Database;
  aiService?: Pick<AiService, "generateStructured">;
  settingsService: Pick<SettingsService, "get" | "setInternal">;
  logger?: Logger;
}) {
  const repository = createTagsRepository({ db });
  const documentsRepository = createDocumentsRepository({ db });
  const rulesRepository = createRulesRepository({ db });

  async function getTagOrThrow(userId: string, tagId: string): Promise<Tag> {
    const tag = await repository.findTagById({ userId, tagId });
    if (!tag) throw tagNotFound(tagId);
    return tag;
  }

  async function getCategoryOrThrow(userId: string, categoryId: string): Promise<Category> {
    const category = await repository.findCategoryById({ userId, categoryId });
    if (!category) throw categoryNotFound(categoryId);
    return category;
  }

  async function getTypeOrThrow(userId: string, typeId: string): Promise<DocumentType> {
    const type = await repository.findTypeById({ userId, typeId });
    if (!type) throw typeNotFound(typeId);
    return type;
  }

  async function ensureDocumentExists(userId: string, documentId: string) {
    const document = await documentsRepository.findById({ userId, documentId });
    if (!document) throw documentNotFound(documentId);
    return document;
  }

  // autoApply is an integer 0/1 column (see decision 27). These two helpers are the
  // only places a Tag or Category becomes client-facing, so they are the only places
  // that need to convert it to a real boolean.
  function presentTag(tag: Tag, documentCount: number): TagWithCount {
    return { ...tag, autoApply: tag.autoApply === 1, documentCount };
  }

  function presentCategory(category: Category, path: string, documentCount: number): CategoryWithMeta {
    return { ...category, autoApply: category.autoApply === 1, path, documentCount };
  }

  function presentType(type: DocumentType, documentCount: number): DocumentTypeWithCount {
    return { ...type, autoApply: type.autoApply === 1, documentCount };
  }

  async function withTagCounts(userId: string, tags: Tag[]): Promise<TagWithCount[]> {
    const counts = await repository.countDocumentsByTag(userId);
    return sortByNameCI(tags).map((t) => presentTag(t, counts.get(t.id) ?? 0));
  }

  async function withCategoryMeta(userId: string, categories: Category[]): Promise<CategoryWithMeta[]> {
    const [counts, paths] = await Promise.all([repository.countDocumentsByCategory(userId), Promise.resolve(buildCategoryPaths(categories))]);
    return sortCategories(categories).map((c) => presentCategory(c, paths.get(c.id) ?? c.name, counts.get(c.id) ?? 0));
  }

  async function withTypeCounts(userId: string, types: DocumentType[]): Promise<DocumentTypeWithCount[]> {
    const counts = await repository.countDocumentsByType(userId);
    return sortByNameCI(types).map((t) => presentType(t, counts.get(t.id) ?? 0));
  }

  function buildPresetType(userId: string, preset: { name: string; description: string }): NewDocumentType {
    const t = nowIso();
    return {
      id: newDocumentTypeId(),
      userId,
      name: preset.name,
      description: preset.description,
      color: null,
      confidenceThreshold: 0.7,
      autoApply: 1,
      createdAt: t,
      updatedAt: t,
    };
  }

  // Reads every retired documentType field row for the user, resolves it through
  // RETIRED_TYPE_VALUE_MAP against the just-seeded presets, and writes the winning
  // type onto its document. Runs after the presets exist so the lookup by name finds
  // them, and deletes every row it read in the same transaction as the writes, so a
  // document is never left pointing at a type while its old field row still exists.
  async function migrateExtractedTypes({ userId }: { userId: string }) {
    const rows = await repository.listDocumentTypeFieldRows({ userId });
    if (rows.length === 0) return;

    const types = await repository.listTypesRaw(userId);
    const typeByName = new Map(types.map((t) => [t.name.toLowerCase(), t]));

    await db.transaction(async (tx) => {
      const txDb = asTxDb(tx);
      for (const row of rows) {
        const presetName = RETIRED_TYPE_VALUE_MAP[row.value];
        const type = presetName ? typeByName.get(presetName.toLowerCase()) : undefined;
        if (type) {
          await documentsRepository.update({
            userId,
            documentId: row.documentId,
            patch: { documentTypeId: type.id, documentTypeSource: "auto", updatedAt: nowIso() },
            tx: txDb,
          });
        } else if (row.value !== "other") {
          // "other" is the expected case for "matched nothing" and is not logged. Any
          // other unrecognised value is left on the document as no type, but is worth a
          // trace since it means the retired enum had a value this map does not know.
          logger.info({ userId, documentId: row.documentId, value: row.value }, "Unrecognised document type value left unmapped");
        }
      }
      await repository.deleteDocumentTypeFieldRows({ userId, tx: txDb });
    });
  }

  // Not called at server start. A fresh install has no user at boot: sign up closes
  // after the first account and happens once the process is already serving, so a boot
  // time step would find nobody and never run again. Callers pass a real userId.
  async function ensureTypesSeeded({ userId }: { userId: string }) {
    const done = await settingsService.get<boolean>(userId, "types.presetsSeeded");
    if (done) return;

    // Inserted one at a time, not as a batch. The guard flag cannot commit in the same
    // transaction as these rows, because the settings repository takes no tx, so a crash
    // between the inserts and the flag has to leave a retry able to finish. A name the
    // user already owns is skipped, never overwritten.
    for (const preset of DOCUMENT_TYPE_PRESETS) {
      try {
        await repository.insertType(buildPresetType(userId, preset));
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          logger.info({ userId, name: preset.name }, "Preset document type skipped, the name is already taken");
          continue;
        }
        throw error;
      }
    }

    await migrateExtractedTypes({ userId });
    await settingsService.setInternal(userId, "types.presetsSeeded", true);
  }

  return {
    async listTags(userId: string) {
      return withTagCounts(userId, await repository.listTagsRaw(userId));
    },

    async createTag({
      userId,
      name,
      color = null,
      description = "",
      confidenceThreshold = 0.7,
      autoApply = true,
    }: {
      userId: string;
      name: string;
      color?: string | null;
      description?: string;
      confidenceThreshold?: number;
      autoApply?: boolean;
    }): Promise<TagWithCount> {
      const id = newTagId();
      const t = nowIso();
      const tag: NewTag = {
        id,
        userId,
        name: normalizeName(name),
        color,
        description,
        confidenceThreshold,
        autoApply: autoApply ? 1 : 0,
        createdAt: t,
        updatedAt: t,
      };
      try {
        await repository.insertTag(tag);
      } catch (error) {
        if (isUniqueConstraintError(error)) throw tagDuplicateName();
        throw error;
      }
      return presentTag(await getTagOrThrow(userId, id), 0);
    },

    async updateTag({ userId, tagId, patch }: { userId: string; tagId: string; patch: TagPatch }): Promise<TagWithCount> {
      const existing = await getTagOrThrow(userId, tagId);
      const dbPatch: Partial<NewTag> = { updatedAt: nowIso() };
      if (patch.name !== undefined) dbPatch.name = normalizeName(patch.name);
      if (patch.color !== undefined) dbPatch.color = patch.color;
      if (patch.description !== undefined) dbPatch.description = patch.description;
      if (patch.confidenceThreshold !== undefined) dbPatch.confidenceThreshold = patch.confidenceThreshold;
      if (patch.autoApply !== undefined) dbPatch.autoApply = patch.autoApply ? 1 : 0;
      try {
        await db.transaction(async (tx) => {
          const txDb = asTxDb(tx);
          await repository.updateTag({ userId, tagId, patch: dbPatch, tx: txDb });
          if (patch.autoApply === false && existing.autoApply === 1) {
            await repository.clearAutoTagOnDocuments({ tagId, tx: txDb });
          }
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) throw tagDuplicateName();
        throw error;
      }
      const counts = await repository.countDocumentsByTag(userId);
      return presentTag(await getTagOrThrow(userId, tagId), counts.get(tagId) ?? 0);
    },

    async deleteTag({ userId, tagId }: { userId: string; tagId: string }) {
      await getTagOrThrow(userId, tagId);
      await db.transaction(async (tx) => {
        const txDb = asTxDb(tx);
        await rulesRepository.deleteEvaluationsForTarget({ targetType: "tag", targetId: tagId, tx: txDb });
        await repository.deleteTag({ userId, tagId, tx: txDb });
      });
    },

    async listCategories(userId: string) {
      return withCategoryMeta(userId, await repository.listCategoriesRaw(userId));
    },

    async createCategory({
      userId,
      name,
      parentId = null,
      color = null,
      description = "",
      confidenceThreshold = 0.7,
      autoApply = true,
    }: {
      userId: string;
      name: string;
      parentId?: string | null;
      color?: string | null;
      description?: string;
      confidenceThreshold?: number;
      autoApply?: boolean;
    }): Promise<CategoryWithMeta> {
      const existingCategories = await repository.listCategoriesRaw(userId);
      if (parentId !== null && !existingCategories.some((c) => c.id === parentId)) {
        // Same error as updateCategory uses for an unknown or foreign parent (review
        // finding 3); createCategory previously threw categories.not_found here instead.
        throw categoryInvalidParent();
      }
      const siblings = existingCategories.filter((c) => c.parentId === parentId);
      const id = newCategoryId();
      const t = nowIso();
      const category: NewCategory = {
        id,
        userId,
        name: normalizeName(name),
        parentId,
        color,
        description,
        confidenceThreshold,
        autoApply: autoApply ? 1 : 0,
        sortOrder: nextSortOrder(siblings.map((s) => s.sortOrder)),
        createdAt: t,
        updatedAt: t,
      };
      try {
        await repository.insertCategory(category);
      } catch (error) {
        if (isUniqueConstraintError(error)) throw categoryDuplicateName();
        throw error;
      }
      const paths = buildCategoryPaths(await repository.listCategoriesRaw(userId));
      return presentCategory(await getCategoryOrThrow(userId, id), paths.get(id) ?? category.name, 0);
    },

    async updateCategory({ userId, categoryId, patch }: { userId: string; categoryId: string; patch: CategoryPatch }): Promise<CategoryWithMeta> {
      const existing = await getCategoryOrThrow(userId, categoryId);
      if (patch.parentId !== undefined && patch.parentId !== existing.parentId) {
        if (patch.parentId !== null) {
          const all = await repository.listCategoriesRaw(userId);
          const parentExists = all.some((c) => c.id === patch.parentId);
          if (!parentExists || wouldCreateCycle(all, categoryId, patch.parentId)) throw categoryInvalidParent();
        }
      }
      const dbPatch: Partial<NewCategory> = { updatedAt: nowIso() };
      if (patch.name !== undefined) dbPatch.name = normalizeName(patch.name);
      if (patch.parentId !== undefined) dbPatch.parentId = patch.parentId;
      if (patch.color !== undefined) dbPatch.color = patch.color;
      if (patch.description !== undefined) dbPatch.description = patch.description;
      if (patch.confidenceThreshold !== undefined) dbPatch.confidenceThreshold = patch.confidenceThreshold;
      if (patch.autoApply !== undefined) dbPatch.autoApply = patch.autoApply ? 1 : 0;
      if (patch.sortOrder !== undefined) dbPatch.sortOrder = patch.sortOrder;
      try {
        // The category patch and clearing auto-sourced documents must commit together
        // (review finding 1): if the second statement failed after the first outside a
        // transaction, the category would end up with autoApply off while its
        // auto-sourced documents kept a stale category link.
        await db.transaction(async (tx) => {
          const txDb = asTxDb(tx);
          await repository.updateCategory({ userId, categoryId, patch: dbPatch, tx: txDb });
          if (patch.autoApply === false && existing.autoApply === 1) {
            await repository.clearAutoCategoryOnDocuments({ userId, categoryId, tx: txDb });
          }
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) throw categoryDuplicateName();
        throw error;
      }
      const counts = await repository.countDocumentsByCategory(userId);
      const paths = buildCategoryPaths(await repository.listCategoriesRaw(userId));
      const updated = await getCategoryOrThrow(userId, categoryId);
      return presentCategory(updated, paths.get(categoryId) ?? updated.name, counts.get(categoryId) ?? 0);
    },

    async deleteCategory({ userId, categoryId }: { userId: string; categoryId: string }) {
      const category = await getCategoryOrThrow(userId, categoryId);
      await db.transaction(async (tx) => {
        const txDb = asTxDb(tx);
        await repository.reparentChildren({ userId, oldParentId: categoryId, newParentId: category.parentId, tx: txDb });
        await repository.clearCategoryOnDocuments({ userId, categoryId, tx: txDb });
        await rulesRepository.deleteEvaluationsForTarget({ targetType: "category", targetId: categoryId, tx: txDb });
        await repository.deleteCategory({ userId, categoryId, tx: txDb });
      });
    },

    async reorderCategories({
      userId,
      a,
      b,
    }: {
      userId: string;
      a: { id: string; sortOrder: number };
      b: { id: string; sortOrder: number };
    }): Promise<[CategoryWithMeta, CategoryWithMeta]> {
      await getCategoryOrThrow(userId, a.id);
      await getCategoryOrThrow(userId, b.id);
      const updatedAt = nowIso();
      // Both writes must commit as one unit: a swap is two categories trading sort
      // positions, so applying only one of them would leave two categories sharing a
      // sortOrder or the move only half done.
      await db.transaction(async (tx) => {
        const txDb = asTxDb(tx);
        await repository.updateCategory({ userId, categoryId: a.id, patch: { sortOrder: a.sortOrder, updatedAt }, tx: txDb });
        await repository.updateCategory({ userId, categoryId: b.id, patch: { sortOrder: b.sortOrder, updatedAt }, tx: txDb });
      });
      const [counts, categories] = await Promise.all([repository.countDocumentsByCategory(userId), repository.listCategoriesRaw(userId)]);
      const paths = buildCategoryPaths(categories);
      const updatedA = await getCategoryOrThrow(userId, a.id);
      const updatedB = await getCategoryOrThrow(userId, b.id);
      return [
        presentCategory(updatedA, paths.get(a.id) ?? updatedA.name, counts.get(a.id) ?? 0),
        presentCategory(updatedB, paths.get(b.id) ?? updatedB.name, counts.get(b.id) ?? 0),
      ];
    },

    ensureTypesSeeded,

    async listTypes(userId: string) {
      await ensureTypesSeeded({ userId });
      return withTypeCounts(userId, await repository.listTypesRaw(userId));
    },

    async createType({
      userId,
      name,
      color = null,
      description = "",
      confidenceThreshold = 0.7,
      autoApply = true,
    }: {
      userId: string;
      name: string;
      color?: string | null;
      description?: string;
      confidenceThreshold?: number;
      autoApply?: boolean;
    }): Promise<DocumentTypeWithCount> {
      const id = newDocumentTypeId();
      const t = nowIso();
      const type: NewDocumentType = {
        id,
        userId,
        name: normalizeName(name),
        color,
        description,
        confidenceThreshold,
        autoApply: autoApply ? 1 : 0,
        createdAt: t,
        updatedAt: t,
      };
      try {
        await repository.insertType(type);
      } catch (error) {
        if (isUniqueConstraintError(error)) throw typeDuplicateName();
        throw error;
      }
      return presentType(await getTypeOrThrow(userId, id), 0);
    },

    async updateType({ userId, typeId, patch }: { userId: string; typeId: string; patch: TypePatch }): Promise<DocumentTypeWithCount> {
      const existing = await getTypeOrThrow(userId, typeId);
      const dbPatch: Partial<NewDocumentType> = { updatedAt: nowIso() };
      if (patch.name !== undefined) dbPatch.name = normalizeName(patch.name);
      if (patch.color !== undefined) dbPatch.color = patch.color;
      if (patch.description !== undefined) dbPatch.description = patch.description;
      if (patch.confidenceThreshold !== undefined) dbPatch.confidenceThreshold = patch.confidenceThreshold;
      if (patch.autoApply !== undefined) dbPatch.autoApply = patch.autoApply ? 1 : 0;
      try {
        // The type patch and clearing auto-sourced documents must commit together, the
        // same reasoning as updateCategory: turning autoApply off while its auto-sourced
        // documents kept a stale type link would be a state the UI cannot express.
        await db.transaction(async (tx) => {
          const txDb = asTxDb(tx);
          await repository.updateType({ userId, typeId, patch: dbPatch, tx: txDb });
          if (patch.autoApply === false && existing.autoApply === 1) {
            await repository.clearAutoTypeOnDocuments({ userId, typeId, tx: txDb });
          }
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) throw typeDuplicateName();
        throw error;
      }
      const counts = await repository.countDocumentsByType(userId);
      return presentType(await getTypeOrThrow(userId, typeId), counts.get(typeId) ?? 0);
    },

    async deleteType({ userId, typeId }: { userId: string; typeId: string }) {
      await getTypeOrThrow(userId, typeId);
      await db.transaction(async (tx) => {
        const txDb = asTxDb(tx);
        await repository.clearTypeOnDocuments({ userId, typeId, tx: txDb });
        await rulesRepository.deleteEvaluationsForTarget({ targetType: "type", targetId: typeId, tx: txDb });
        await repository.deleteType({ userId, typeId, tx: txDb });
      });
    },

    async setDocumentType({
      userId,
      documentId,
      documentTypeId,
    }: {
      userId: string;
      documentId: string;
      documentTypeId: string | null;
    }) {
      await ensureDocumentExists(userId, documentId);
      if (documentTypeId !== null) await getTypeOrThrow(userId, documentTypeId);
      await documentsRepository.update({
        userId,
        documentId,
        patch: { documentTypeId, documentTypeSource: documentTypeId === null ? null : "manual", updatedAt: nowIso() },
      });
      return documentsRepository.findByIdWithExtras({ userId, documentId });
    },

    async setDocumentCategory({
      userId,
      documentId,
      categoryId,
    }: {
      userId: string;
      documentId: string;
      categoryId: string | null;
    }) {
      await ensureDocumentExists(userId, documentId);
      if (categoryId !== null) await getCategoryOrThrow(userId, categoryId);
      await documentsRepository.update({
        userId,
        documentId,
        patch: { categoryId, categorySource: categoryId === null ? null : "manual", updatedAt: nowIso() },
      });
      return documentsRepository.findByIdWithExtras({ userId, documentId });
    },

    async setDocumentTag({ userId, documentId, tagId }: { userId: string; documentId: string; tagId: string }): Promise<TagChip[]> {
      await ensureDocumentExists(userId, documentId);
      await getTagOrThrow(userId, tagId);
      await repository.upsertDocumentTagManual({ documentId, tagId, manual: true });
      return repository.listTagsForDocument(documentId);
    },

    async clearDocumentTag({ userId, documentId, tagId }: { userId: string; documentId: string; tagId: string }): Promise<TagChip[]> {
      await ensureDocumentExists(userId, documentId);
      await getTagOrThrow(userId, tagId);
      await repository.upsertDocumentTagManual({ documentId, tagId, manual: false });
      return repository.listTagsForDocument(documentId);
    },

    // Uses the rules model slot deliberately: this description is consumed by the
    // sorter, which runs on that slot, so the same model should write it. Any error
    // from aiService (including "no rules model configured") is left to propagate to
    // the route unchanged so the client gets a clear, structured error to toast.
    async suggestDescription({
      userId,
      targetType,
      name,
      description,
    }: {
      userId: string;
      targetType: "tag" | "category" | "type";
      name: string;
      description: string;
    }): Promise<{ suggestion: string }> {
      if (!aiService) {
        throw createError({
          code: "tags.description_assistant_unavailable",
          message: "The description assistant is not available.",
          status: 500,
        });
      }
      const { system, input } = buildDescriptionAssistantPrompt({ targetType, name, description });
      const { data } = await aiService.generateStructured<{ description: string }>({
        userId,
        task: "rules",
        schema: descriptionAssistantReplySchema,
        schemaName: "description_suggestion",
        system,
        input,
      });
      return { suggestion: trimDescriptionSuggestion(data.description, descriptionAssistantLimit(targetType)) };
    },
  };
}

export type TagsService = ReturnType<typeof createTagsService>;
