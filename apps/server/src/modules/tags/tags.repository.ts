import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { asTxDb, type Database } from "../database/database.js";
import { documentsTable } from "../documents/documents.tables.js";
import { categoriesTable, documentTagsTable, tagsTable } from "./tags.tables.js";
import type { Category, DocumentTag, NewCategory, NewTag, Tag, TagChip } from "./tags.types.js";

export function createTagsRepository({ db }: { db: Database }) {
  return {
    async insertTag(tag: NewTag) {
      await db.insert(tagsTable).values(tag);
    },
    async findTagById({ userId, tagId }: { userId: string; tagId: string }): Promise<Tag | null> {
      const [row] = await db.select().from(tagsTable).where(and(eq(tagsTable.userId, userId), eq(tagsTable.id, tagId)));
      return row ?? null;
    },
    async listTagsRaw(userId: string): Promise<Tag[]> {
      return db.select().from(tagsTable).where(eq(tagsTable.userId, userId));
    },
    async countDocumentsByTag(userId: string): Promise<Map<string, number>> {
      const rows = await db
        .select({ tagId: documentTagsTable.tagId, count: sql<number>`count(*)` })
        .from(documentTagsTable)
        .innerJoin(tagsTable, eq(documentTagsTable.tagId, tagsTable.id))
        .where(eq(tagsTable.userId, userId))
        .groupBy(documentTagsTable.tagId);
      return new Map(rows.map((r) => [r.tagId, Number(r.count)]));
    },
    async updateTag({ userId, tagId, patch, tx = db }: { userId: string; tagId: string; patch: Partial<NewTag>; tx?: Database }) {
      await tx.update(tagsTable).set(patch).where(and(eq(tagsTable.userId, userId), eq(tagsTable.id, tagId)));
    },
    async deleteTag({ userId, tagId, tx = db }: { userId: string; tagId: string; tx?: Database }) {
      await tx.delete(tagsTable).where(and(eq(tagsTable.userId, userId), eq(tagsTable.id, tagId)));
    },

    async insertCategory(category: NewCategory) {
      await db.insert(categoriesTable).values(category);
    },
    async findCategoryById({ userId, categoryId }: { userId: string; categoryId: string }): Promise<Category | null> {
      const [row] = await db.select().from(categoriesTable).where(and(eq(categoriesTable.userId, userId), eq(categoriesTable.id, categoryId)));
      return row ?? null;
    },
    async listCategoriesRaw(userId: string): Promise<Category[]> {
      return db.select().from(categoriesTable).where(eq(categoriesTable.userId, userId));
    },
    async countDocumentsByCategory(userId: string): Promise<Map<string, number>> {
      const rows = await db
        .select({ categoryId: documentsTable.categoryId, count: sql<number>`count(*)` })
        .from(documentsTable)
        .where(and(eq(documentsTable.userId, userId), isNotNull(documentsTable.categoryId)))
        .groupBy(documentsTable.categoryId);
      return new Map(rows.map((r) => [r.categoryId as string, Number(r.count)]));
    },
    async updateCategory({
      userId,
      categoryId,
      patch,
      tx = db,
    }: {
      userId: string;
      categoryId: string;
      patch: Partial<NewCategory>;
      tx?: Database;
    }) {
      await tx.update(categoriesTable).set(patch).where(and(eq(categoriesTable.userId, userId), eq(categoriesTable.id, categoryId)));
    },
    async deleteCategory({ userId, categoryId, tx = db }: { userId: string; categoryId: string; tx?: Database }) {
      await tx.delete(categoriesTable).where(and(eq(categoriesTable.userId, userId), eq(categoriesTable.id, categoryId)));
    },
    async reparentChildren({
      userId,
      oldParentId,
      newParentId,
      tx = db,
    }: {
      userId: string;
      oldParentId: string;
      newParentId: string | null;
      tx?: Database;
    }) {
      await tx
        .update(categoriesTable)
        .set({ parentId: newParentId })
        .where(and(eq(categoriesTable.userId, userId), eq(categoriesTable.parentId, oldParentId)));
    },
    async clearCategoryOnDocuments({ userId, categoryId, tx = db }: { userId: string; categoryId: string; tx?: Database }) {
      await tx
        .update(documentsTable)
        .set({ categoryId: null, categorySource: null })
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.categoryId, categoryId)));
    },
    async clearAutoCategoryOnDocuments({
      userId,
      categoryId,
      tx = db,
    }: {
      userId: string;
      categoryId: string;
      tx?: Database;
    }) {
      await tx
        .update(documentsTable)
        .set({ categoryId: null, categorySource: null })
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.categoryId, categoryId), eq(documentsTable.categorySource, "auto")));
    },

    async clearAutoTagOnDocuments({ tagId, tx = db }: { tagId: string; tx?: Database }) {
      // Clear the flag first, then delete any link left with both flags at 0: a link
      // with neither flag set is meaningless (document_tags' own invariant), so leaving
      // it behind would silently inflate nothing but is still worth tidying up.
      await tx.update(documentTagsTable).set({ appliedByAuto: 0 }).where(and(eq(documentTagsTable.tagId, tagId), eq(documentTagsTable.appliedByAuto, 1)));
      await tx
        .delete(documentTagsTable)
        .where(and(eq(documentTagsTable.tagId, tagId), eq(documentTagsTable.appliedByAuto, 0), eq(documentTagsTable.appliedByManual, 0)));
    },

    async findDocumentTag({ documentId, tagId }: { documentId: string; tagId: string }): Promise<DocumentTag | null> {
      const [row] = await db
        .select()
        .from(documentTagsTable)
        .where(and(eq(documentTagsTable.documentId, documentId), eq(documentTagsTable.tagId, tagId)));
      return row ?? null;
    },
    async upsertDocumentTagManual({ documentId, tagId, manual }: { documentId: string; tagId: string; manual: boolean }) {
      // The read and the write below must commit as one unit: two concurrent calls for
      // the same (documentId, tagId) pair would otherwise both see "no row" and both
      // try to insert, hitting the primary key with an uncaught constraint error.
      // Running both inside one db.transaction serializes that check-then-act.
      await db.transaction(async (tx) => {
        const txDb = asTxDb(tx);
        const [existing] = await txDb
          .select()
          .from(documentTagsTable)
          .where(and(eq(documentTagsTable.documentId, documentId), eq(documentTagsTable.tagId, tagId)));
        if (!existing) {
          if (!manual) return;
          await txDb.insert(documentTagsTable).values({ documentId, tagId, appliedByManual: 1, appliedByAuto: 0 });
          return;
        }
        const appliedByManual = manual ? 1 : 0;
        if (appliedByManual === 0 && existing.appliedByAuto === 0) {
          await txDb.delete(documentTagsTable).where(and(eq(documentTagsTable.documentId, documentId), eq(documentTagsTable.tagId, tagId)));
          return;
        }
        await txDb
          .update(documentTagsTable)
          .set({ appliedByManual })
          .where(and(eq(documentTagsTable.documentId, documentId), eq(documentTagsTable.tagId, tagId)));
      });
    },
    async listTagsForDocument(documentId: string): Promise<TagChip[]> {
      const rows = await db
        .select({
          id: tagsTable.id,
          name: tagsTable.name,
          color: tagsTable.color,
          appliedByAuto: documentTagsTable.appliedByAuto,
          appliedByManual: documentTagsTable.appliedByManual,
        })
        .from(documentTagsTable)
        .innerJoin(tagsTable, eq(documentTagsTable.tagId, tagsTable.id))
        .where(eq(documentTagsTable.documentId, documentId));
      return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, auto: r.appliedByAuto === 1, manual: r.appliedByManual === 1 }));
    },
    async listTagsForDocuments(documentIds: string[]): Promise<Map<string, TagChip[]>> {
      const map = new Map<string, TagChip[]>();
      if (documentIds.length === 0) return map;
      const rows = await db
        .select({
          documentId: documentTagsTable.documentId,
          id: tagsTable.id,
          name: tagsTable.name,
          color: tagsTable.color,
          appliedByAuto: documentTagsTable.appliedByAuto,
          appliedByManual: documentTagsTable.appliedByManual,
        })
        .from(documentTagsTable)
        .innerJoin(tagsTable, eq(documentTagsTable.tagId, tagsTable.id))
        .where(inArray(documentTagsTable.documentId, documentIds));
      for (const r of rows) {
        const chip: TagChip = { id: r.id, name: r.name, color: r.color, auto: r.appliedByAuto === 1, manual: r.appliedByManual === 1 };
        const list = map.get(r.documentId) ?? [];
        list.push(chip);
        map.set(r.documentId, list);
      }
      return map;
    },
  };
}

export type TagsRepository = ReturnType<typeof createTagsRepository>;
