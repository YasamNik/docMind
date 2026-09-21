import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Database } from "../database/database.js";
import { buildCategoryPaths, collectDescendantIds } from "../tags/tags.models.js";
import { sortEvaluationsTable } from "../rules/rules.tables.js";
import { categoriesTable, documentTagsTable, documentTypesTable, tagsTable } from "../tags/tags.tables.js";
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
  documentTypeId: documentsTable.documentTypeId,
  documentTypeSource: documentsTable.documentTypeSource,
  documentDate: documentsTable.documentDate,
  triageStatus: documentsTable.triageStatus,
  parentDocumentId: documentsTable.parentDocumentId,
  deletedAt: documentsTable.deletedAt,
  createdAt: documentsTable.createdAt,
  updatedAt: documentsTable.updatedAt,
};

export function createDocumentsRepository({ db }: { db: Database }) {
  async function loadCategoryPathMap(userId: string) {
    const categories = await db.select().from(categoriesTable).where(eq(categoriesTable.userId, userId));
    return buildCategoryPaths(categories);
  }

  // Types have no hierarchy, so this is a plain id to name map rather than a path builder.
  async function loadDocumentTypeNameMap(userId: string): Promise<Map<string, string>> {
    const types = await db
      .select({ id: documentTypesTable.id, name: documentTypesTable.name })
      .from(documentTypesTable)
      .where(eq(documentTypesTable.userId, userId));
    return new Map(types.map((t) => [t.id, t.name]));
  }

  // Shared by listByUser and countByUser so the inbox and needs_review definitions
  // cannot drift between the row fetch and the count-only path.
  async function buildViewConditions(userId: string, view: DocumentView, { includeBudgetSource = false }: { includeBudgetSource?: boolean } = {}) {
    const conditions = [eq(documentsTable.userId, userId)];
    if (view === "trash") {
      conditions.push(isNotNull(documentsTable.deletedAt));
      return conditions;
    }
    conditions.push(isNull(documentsTable.deletedAt));
    // A receipt's pages belong to the budget module, already filed under a receipt, so
    // they never surface in the library's own views. Left out of the trash branch above:
    // a trashed receipt page still needs to show there, since that is where the budget
    // module tells the user a deleted receipt can be restored from. includeBudgetSource
    // is for the handful of maintenance callers (re-embedding, the storage picker's
    // per-driver count) that must still see every document regardless of ownership.
    if (!includeBudgetSource) conditions.push(ne(documentsTable.source, "budget"));
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
      documentTypeId,
      tagId,
      view = "all",
      storageDriver,
      includeBudgetSource,
    }: {
      userId: string;
      categoryId?: string;
      documentTypeId?: string;
      tagId?: string;
      view?: DocumentView;
      storageDriver?: string;
      // See buildViewConditions: only reembedAll (search.usecases.ts) needs this today,
      // so an outdated vector for a receipt page keeps getting refreshed.
      includeBudgetSource?: boolean;
    }): Promise<DocumentListRow[]> {
      const conditions = await buildViewConditions(userId, view, { includeBudgetSource });
      // Fetched once and reused for both the categoryId filter (descendant ids) and the
      // path map below, instead of querying all of the user's categories twice.
      const categories = await db.select().from(categoriesTable).where(eq(categoriesTable.userId, userId));
      if (categoryId) {
        const ids = [categoryId, ...collectDescendantIds(categories, categoryId)];
        conditions.push(inArray(documentsTable.categoryId, ids));
      }
      if (documentTypeId) {
        conditions.push(eq(documentsTable.documentTypeId, documentTypeId));
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
      const typeNameMap = await loadDocumentTypeNameMap(userId);
      const documentIds = rows.map((r) => r.id);
      const [tagsMap, fieldsMap] = await Promise.all([loadTagsByDocument(documentIds), loadFieldsByDocument(documentIds)]);
      return rows.map((row) => ({
        ...row,
        categoryPath: row.categoryId ? (pathMap.get(row.categoryId) ?? null) : null,
        documentTypeName: row.documentTypeId ? (typeNameMap.get(row.documentTypeId) ?? null) : null,
        tags: tagsMap.get(row.id) ?? [],
        fields: fieldsMap.get(row.id) ?? [],
      }));
    },

    async countByUser({
      userId,
      view,
      storageDriver,
      includeBudgetSource,
    }: {
      userId: string;
      view: DocumentView;
      storageDriver?: string;
      // See buildViewConditions: the storage picker's per-driver count needs this, so a
      // receipt's pages still count toward what actually sits on that driver.
      includeBudgetSource?: boolean;
    }): Promise<number> {
      const conditions = await buildViewConditions(userId, view, { includeBudgetSource });
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
    }): Promise<(Document & { categoryPath: string | null; documentTypeName: string | null; tags: TagChip[]; fields: ExtractedField[] }) | null> {
      const [row] = await db
        .select()
        .from(documentsTable)
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.id, documentId)));
      if (!row) return null;
      const [pathMap, typeNameMap, tagsMap, fieldsMap] = await Promise.all([
        loadCategoryPathMap(userId),
        loadDocumentTypeNameMap(userId),
        loadTagsByDocument([row.id]),
        loadFieldsByDocument([row.id]),
      ]);
      return {
        ...row,
        categoryPath: row.categoryId ? (pathMap.get(row.categoryId) ?? null) : null,
        documentTypeName: row.documentTypeId ? (typeNameMap.get(row.documentTypeId) ?? null) : null,
        tags: tagsMap.get(row.id) ?? [],
        fields: fieldsMap.get(row.id) ?? [],
      };
    },

    async findByHash({ userId, contentHash }: { userId: string; contentHash: string }): Promise<Document | null> {
      const [row] = await db
        .select()
        .from(documentsTable)
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.contentHash, contentHash), isNull(documentsTable.deletedAt)));
      return row ?? null;
    },

    // The direct children of a document, for example the attachments a mail arrived
    // with. Used to delete a subtree explicitly rather than relying only on the
    // database's own cascade.
    async findChildren({ userId, documentId }: { userId: string; documentId: string }): Promise<Document[]> {
      return db
        .select()
        .from(documentsTable)
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.parentDocumentId, documentId)));
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
      sinceId,
      limit = 20,
    }: {
      userId: string;
      source: string;
      since: string;
      // Id of the document at `since`, so the cursor matches the query's own
      // (createdAt, id) order. Without it, two documents sharing the exact createdAt
      // at the watermark would mean the one not yet reported can never satisfy a plain
      // gt(createdAt, since) again. Left undefined only for a watermark with no id yet.
      sinceId?: string;
      limit?: number;
    }): Promise<DocumentListRow[]> {
      const pastWatermark = sinceId
        ? or(gt(documentsTable.createdAt, since), and(eq(documentsTable.createdAt, since), gt(documentsTable.id, sinceId)))!
        : gt(documentsTable.createdAt, since);
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
            pastWatermark,
          ),
        )
        .orderBy(asc(documentsTable.createdAt), asc(documentsTable.id))
        .limit(limit);

      const pathMap = await loadCategoryPathMap(userId);
      const typeNameMap = await loadDocumentTypeNameMap(userId);
      const documentIds = rows.map((r) => r.id);
      const tagsMap = await loadTagsByDocument(documentIds);
      return rows.map((row) => ({
        ...row,
        categoryPath: row.categoryId ? (pathMap.get(row.categoryId) ?? null) : null,
        documentTypeName: row.documentTypeId ? (typeNameMap.get(row.documentTypeId) ?? null) : null,
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
