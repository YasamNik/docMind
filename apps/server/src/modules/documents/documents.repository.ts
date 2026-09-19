import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../database/database.js";
import { buildCategoryPaths, collectDescendantIds } from "../tags/tags.models.js";
import { sortEvaluationsTable } from "../rules/rules.tables.js";
import { categoriesTable, documentTagsTable, tagsTable } from "../tags/tags.tables.js";
import type { TagChip } from "../tags/tags.types.js";
// Queried directly rather than through createFieldsRepository, the same way tags are
// queried directly through their tables here rather than through the tags service.
import { documentFieldsTable } from "../fields/fields.tables.js";
import type { ExtractedField } from "../fields/fields.types.js";
import { documentsTable } from "./documents.tables.js";
import type { Document, DocumentListRow, DocumentView, NewDocument } from "./documents.types.js";

const listColumns = {
  id: documentsTable.id,
  userId: documentsTable.userId,
  name: documentsTable.name,
  mimeType: documentsTable.mimeType,
  sizeBytes: documentsTable.sizeBytes,
  contentHash: documentsTable.contentHash,
  storageDriver: documentsTable.storageDriver,
  storageKey: documentsTable.storageKey,
  source: documentsTable.source,
  extractionStatus: documentsTable.extractionStatus,
  extractionError: documentsTable.extractionError,
  ruleStatus: documentsTable.ruleStatus,
  ruleError: documentsTable.ruleError,
  embeddingStatus: documentsTable.embeddingStatus,
  embeddingError: documentsTable.embeddingError,
  summary: documentsTable.summary,
  suggestedTitle: documentsTable.suggestedTitle,
  summaryStatus: documentsTable.summaryStatus,
  summaryError: documentsTable.summaryError,
  categoryId: documentsTable.categoryId,
  categorySource: documentsTable.categorySource,
  documentDate: documentsTable.documentDate,
  triageStatus: documentsTable.triageStatus,
  deletedAt: documentsTable.deletedAt,
  createdAt: documentsTable.createdAt,
  updatedAt: documentsTable.updatedAt,
};

export function createDocumentsRepository({ db }: { db: Database }) {
  async function loadCategoryPathMap(userId: string) {
    const categories = await db.select().from(categoriesTable).where(eq(categoriesTable.userId, userId));
    return buildCategoryPaths(categories);
  }

  // Shared by listByUser and countByUser so the inbox and needs_review definitions
  // cannot drift between the row fetch and the count-only path.
  async function buildViewConditions(userId: string, view: DocumentView) {
    const conditions = [eq(documentsTable.userId, userId)];
    if (view === "trash") {
      conditions.push(isNotNull(documentsTable.deletedAt));
      return conditions;
    }
    conditions.push(isNull(documentsTable.deletedAt));
    if (view === "inbox") conditions.push(eq(documentsTable.triageStatus, "pending"));
    if (view === "needs_review") {
      conditions.push(eq(documentsTable.ruleStatus, "done"));
      const proposedRows = await db
        .selectDistinct({ documentId: sortEvaluationsTable.documentId })
        .from(sortEvaluationsTable)
        .where(eq(sortEvaluationsTable.outcome, "proposed"));
      const proposedIds = proposedRows.map((r) => r.documentId);
      conditions.push(proposedIds.length > 0 ? or(isNull(documentsTable.categoryId), inArray(documentsTable.id, proposedIds))! : isNull(documentsTable.categoryId));
    }
    return conditions;
  }

  async function loadTagsByDocument(documentIds: string[]): Promise<Map<string, TagChip[]>> {
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
  }

  async function loadFieldsByDocument(documentIds: string[]): Promise<Map<string, ExtractedField[]>> {
    const map = new Map<string, ExtractedField[]>();
    if (documentIds.length === 0) return map;
    const rows = await db.select().from(documentFieldsTable).where(inArray(documentFieldsTable.documentId, documentIds));
    for (const row of rows as ExtractedField[]) {
      const list = map.get(row.documentId) ?? [];
      list.push(row);
      map.set(row.documentId, list);
    }
    return map;
  }

  return {
    async insert(document: NewDocument, tx: Database = db) {
      await tx.insert(documentsTable).values(document);
    },

    async listByUser({
      userId,
      categoryId,
      tagId,
      view = "all",
      storageDriver,
    }: {
      userId: string;
      categoryId?: string;
      tagId?: string;
      view?: DocumentView;
      storageDriver?: string;
    }): Promise<DocumentListRow[]> {
      const conditions = await buildViewConditions(userId, view);
      // Fetched once and reused for both the categoryId filter (descendant ids) and the
      // path map below, instead of querying all of the user's categories twice.
      const categories = await db.select().from(categoriesTable).where(eq(categoriesTable.userId, userId));
      if (categoryId) {
        const ids = [categoryId, ...collectDescendantIds(categories, categoryId)];
        conditions.push(inArray(documentsTable.categoryId, ids));
      }
      if (tagId) {
        const linked = await db.select({ documentId: documentTagsTable.documentId }).from(documentTagsTable).where(eq(documentTagsTable.tagId, tagId));
        const ids = linked.map((r) => r.documentId);
        conditions.push(inArray(documentsTable.id, ids.length > 0 ? ids : ["__none__"]));
      }
      // Applied here rather than inside buildViewConditions: that helper is shared with
      // the rule rerun (rules.usecases.ts), the summary backfill (summary.usecases.ts)
      // and reembedAll (search.usecases.ts), and those must keep seeing every document
      // whatever storage holds it.
      if (storageDriver) conditions.push(eq(documentsTable.storageDriver, storageDriver));

      const rows = await db
        .select(listColumns)
        .from(documentsTable)
        .where(and(...conditions))
        .orderBy(desc(documentsTable.createdAt), desc(documentsTable.id));

      const pathMap = buildCategoryPaths(categories);
      const documentIds = rows.map((r) => r.id);
      const [tagsMap, fieldsMap] = await Promise.all([loadTagsByDocument(documentIds), loadFieldsByDocument(documentIds)]);
      return rows.map((row) => ({
        ...row,
        categoryPath: row.categoryId ? (pathMap.get(row.categoryId) ?? null) : null,
        tags: tagsMap.get(row.id) ?? [],
        fields: fieldsMap.get(row.id) ?? [],
      }));
    },

    async countByUser({ userId, view, storageDriver }: { userId: string; view: DocumentView; storageDriver?: string }): Promise<number> {
      const conditions = await buildViewConditions(userId, view);
      // See listByUser: the jobs that share buildViewConditions must keep counting or
      // listing every document, whatever storage holds it.
      if (storageDriver) conditions.push(eq(documentsTable.storageDriver, storageDriver));
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(documentsTable)
        .where(and(...conditions));
      return row?.count ?? 0;
    },

    async findById({ userId, documentId }: { userId: string; documentId: string }): Promise<Document | null> {
      const [row] = await db
        .select()
        .from(documentsTable)
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.id, documentId)));
      return row ?? null;
    },

    async findByIdWithExtras({
      userId,
      documentId,
    }: {
      userId: string;
      documentId: string;
    }): Promise<(Document & { categoryPath: string | null; tags: TagChip[]; fields: ExtractedField[] }) | null> {
      const [row] = await db
        .select()
        .from(documentsTable)
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.id, documentId)));
      if (!row) return null;
      const [pathMap, tagsMap, fieldsMap] = await Promise.all([
        loadCategoryPathMap(userId),
        loadTagsByDocument([row.id]),
        loadFieldsByDocument([row.id]),
      ]);
      return {
        ...row,
        categoryPath: row.categoryId ? (pathMap.get(row.categoryId) ?? null) : null,
        tags: tagsMap.get(row.id) ?? [],
        fields: fieldsMap.get(row.id) ?? [],
      };
    },

    async findByHash({ userId, contentHash }: { userId: string; contentHash: string }): Promise<Document | null> {
      const [row] = await db
        .select()
        .from(documentsTable)
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.contentHash, contentHash)));
      return row ?? null;
    },

    // For the telegram watcher: which documents from a given source have finished the
    // two independent jobs a reply could say something about. embeddingStatus is left
    // out on purpose, it changes what search can find, not what a reply would say.
    // Oldest first and capped, so one poll cycle never tries to send an unbounded
    // burst of messages after, say, a long outage.
    async listFinishedSince({
      userId,
      source,
      since,
      limit = 20,
    }: {
      userId: string;
      source: string;
      since: string;
      limit?: number;
    }): Promise<DocumentListRow[]> {
      const rows = await db
        .select(listColumns)
        .from(documentsTable)
        .where(
          and(
            eq(documentsTable.userId, userId),
            eq(documentsTable.source, source),
            isNull(documentsTable.deletedAt),
            inArray(documentsTable.summaryStatus, ["done", "failed"]),
            inArray(documentsTable.ruleStatus, ["done", "failed"]),
            gt(documentsTable.createdAt, since),
          ),
        )
        .orderBy(asc(documentsTable.createdAt), asc(documentsTable.id))
        .limit(limit);

      const pathMap = await loadCategoryPathMap(userId);
      const documentIds = rows.map((r) => r.id);
      const tagsMap = await loadTagsByDocument(documentIds);
      return rows.map((row) => ({
        ...row,
        categoryPath: row.categoryId ? (pathMap.get(row.categoryId) ?? null) : null,
        tags: tagsMap.get(row.id) ?? [],
        fields: [],
      }));
    },

    async update({
      userId,
      documentId,
      patch,
      tx = db,
    }: {
      userId: string;
      documentId: string;
      patch: Partial<NewDocument>;
      tx?: Database;
    }) {
      await tx
        .update(documentsTable)
        .set(patch)
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.id, documentId)));
    },

    async remove({ userId, documentId }: { userId: string; documentId: string }) {
      await db.delete(documentsTable).where(and(eq(documentsTable.userId, userId), eq(documentsTable.id, documentId)));
    },

    async updateTriageStatus({
      userId,
      documentId,
      status,
      tx = db,
    }: {
      userId: string;
      documentId: string;
      status: string;
      tx?: Database;
    }) {
      await tx
        .update(documentsTable)
        .set({ triageStatus: status, updatedAt: new Date().toISOString() })
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.id, documentId)));
    },

    async updateTriageStatusBatch({
      userId,
      documentIds,
      status,
    }: {
      userId: string;
      documentIds: string[];
      status: string;
    }): Promise<number> {
      if (documentIds.length === 0) return 0;
      const result = await db
        .update(documentsTable)
        .set({ triageStatus: status, updatedAt: new Date().toISOString() })
        .where(and(eq(documentsTable.userId, userId), inArray(documentsTable.id, documentIds), eq(documentsTable.triageStatus, "pending")));
      return result.rowsAffected;
    },
  };
}

export type DocumentsRepository = ReturnType<typeof createDocumentsRepository>;
