import { LibsqlError } from "@libsql/client";
import { createError } from "../../shared/errors/errors.js";
import type { Database } from "../database/database.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import {
  buildCategoryPaths,
  newCategoryId,
  newTagId,
  nextSortOrder,
  normalizeName,
  nowIso,
  sortByNameCI,
  sortCategories,
  wouldCreateCycle,
} from "./tags.models.js";
import { createTagsRepository } from "./tags.repository.js";
import type { Category, CategoryWithMeta, NewCategory, NewTag, Tag, TagChip, TagWithCount } from "./tags.types.js";

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

type TagPatch = { name?: string; color?: string | null; description?: string; confidenceThreshold?: number; autoApply?: boolean };
type CategoryPatch = TagPatch & { parentId?: string | null; sortOrder?: number };

export function createTagsService({ db }: { db: Database }) {
  const repository = createTagsRepository({ db });
  const documentsRepository = createDocumentsRepository({ db });

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

  async function withTagCounts(userId: string, tags: Tag[]): Promise<TagWithCount[]> {
    const counts = await repository.countDocumentsByTag(userId);
    return sortByNameCI(tags).map((t) => presentTag(t, counts.get(t.id) ?? 0));
  }

  async function withCategoryMeta(userId: string, categories: Category[]): Promise<CategoryWithMeta[]> {
    const [counts, paths] = await Promise.all([repository.countDocumentsByCategory(userId), Promise.resolve(buildCategoryPaths(categories))]);
    return sortCategories(categories).map((c) => presentCategory(c, paths.get(c.id) ?? c.name, counts.get(c.id) ?? 0));
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
      await getTagOrThrow(userId, tagId);
      const dbPatch: Partial<NewTag> = { updatedAt: nowIso() };
      if (patch.name !== undefined) dbPatch.name = normalizeName(patch.name);
      if (patch.color !== undefined) dbPatch.color = patch.color;
      if (patch.description !== undefined) dbPatch.description = patch.description;
      if (patch.confidenceThreshold !== undefined) dbPatch.confidenceThreshold = patch.confidenceThreshold;
      if (patch.autoApply !== undefined) dbPatch.autoApply = patch.autoApply ? 1 : 0;
      try {
        await repository.updateTag({ userId, tagId, patch: dbPatch });
      } catch (error) {
        if (isUniqueConstraintError(error)) throw tagDuplicateName();
        throw error;
      }
      const counts = await repository.countDocumentsByTag(userId);
      return presentTag(await getTagOrThrow(userId, tagId), counts.get(tagId) ?? 0);
    },

    async deleteTag({ userId, tagId }: { userId: string; tagId: string }) {
      await getTagOrThrow(userId, tagId);
      await repository.deleteTag({ userId, tagId });
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
      if (parentId !== null) await getCategoryOrThrow(userId, parentId);
      const siblings = (await repository.listCategoriesRaw(userId)).filter((c) => c.parentId === parentId);
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
        await repository.updateCategory({ userId, categoryId, patch: dbPatch });
      } catch (error) {
        if (isUniqueConstraintError(error)) throw categoryDuplicateName();
        throw error;
      }
      if (patch.autoApply === false && existing.autoApply === 1) {
        await repository.clearAutoCategoryOnDocuments({ userId, categoryId });
      }
      const counts = await repository.countDocumentsByCategory(userId);
      const paths = buildCategoryPaths(await repository.listCategoriesRaw(userId));
      const updated = await getCategoryOrThrow(userId, categoryId);
      return presentCategory(updated, paths.get(categoryId) ?? updated.name, counts.get(categoryId) ?? 0);
    },

    async deleteCategory({ userId, categoryId }: { userId: string; categoryId: string }) {
      const category = await getCategoryOrThrow(userId, categoryId);
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Database;
        await repository.reparentChildren({ userId, oldParentId: categoryId, newParentId: category.parentId, tx: txDb });
        await repository.clearCategoryOnDocuments({ userId, categoryId, tx: txDb });
        await repository.deleteCategory({ userId, categoryId, tx: txDb });
      });
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
      return documentsRepository.findById({ userId, documentId });
    },

    async setDocumentTag({ userId, documentId, tagId }: { userId: string; documentId: string; tagId: string }): Promise<TagChip[]> {
      await ensureDocumentExists(userId, documentId);
      await getTagOrThrow(userId, tagId);
      await repository.upsertDocumentTagManual({ documentId, tagId, manual: true });
      return repository.listTagsForDocument(documentId);
    },

    async clearDocumentTag({ userId, documentId, tagId }: { userId: string; documentId: string; tagId: string }): Promise<TagChip[]> {
      await ensureDocumentExists(userId, documentId);
      await repository.upsertDocumentTagManual({ documentId, tagId, manual: false });
      return repository.listTagsForDocument(documentId);
    },
  };
}

export type TagsService = ReturnType<typeof createTagsService>;
