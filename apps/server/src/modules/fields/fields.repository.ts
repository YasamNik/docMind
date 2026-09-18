import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../database/database.js";
import { documentsTable } from "../documents/documents.tables.js";
import { documentFieldsTable } from "./fields.tables.js";
import type { ExtractedField, FieldKey, NormalizedField } from "./fields.types.js";

export function createFieldsRepository({ db }: { db: Database }) {
  return {
    // Replaces the whole set for a document in one go. The unique index on
    // (document_id, key) means an incremental upsert would have to handle collisions;
    // deleting first is simpler and matches "the model's latest answer wins".
    async replaceForDocument({
      userId,
      documentId,
      fields,
      tx = db,
    }: {
      userId: string;
      documentId: string;
      fields: NormalizedField[];
      tx?: Database;
    }) {
      await tx
        .delete(documentFieldsTable)
        .where(and(eq(documentFieldsTable.userId, userId), eq(documentFieldsTable.documentId, documentId)));
      if (fields.length === 0) return;
      const now = new Date().toISOString();
      await tx.insert(documentFieldsTable).values(
        fields.map((f) => ({
          id: randomUUID(),
          userId,
          documentId,
          key: f.key,
          value: f.value,
          valueNumber: f.valueNumber,
          valueDate: f.valueDate,
          currency: f.currency,
          confidence: f.confidence,
          source: "llm" as const,
          createdAt: now,
          updatedAt: now,
        })),
      );
    },

    async listByDocument({ userId, documentId }: { userId: string; documentId: string }): Promise<ExtractedField[]> {
      const rows = await db
        .select()
        .from(documentFieldsTable)
        .where(and(eq(documentFieldsTable.userId, userId), eq(documentFieldsTable.documentId, documentId)));
      return rows as ExtractedField[];
    },

    async listByDocumentIds({
      userId,
      documentIds,
    }: {
      userId: string;
      documentIds: string[];
    }): Promise<Map<string, ExtractedField[]>> {
      const map = new Map<string, ExtractedField[]>();
      if (documentIds.length === 0) return map;
      const rows = await db
        .select()
        .from(documentFieldsTable)
        .where(and(eq(documentFieldsTable.userId, userId), inArray(documentFieldsTable.documentId, documentIds)));
      for (const row of rows as ExtractedField[]) {
        const list = map.get(row.documentId);
        if (list) list.push(row);
        else map.set(row.documentId, [row]);
      }
      return map;
    },

    // Joins documents so rows belonging to a trashed document stay out of the filter menu,
    // which only ever offers values the library itself can show.
    async listDistinctValues({ userId, key }: { userId: string; key: FieldKey }): Promise<string[]> {
      const rows = await db
        .selectDistinct({ value: documentFieldsTable.value })
        .from(documentFieldsTable)
        .innerJoin(documentsTable, eq(documentsTable.id, documentFieldsTable.documentId))
        .where(
          and(
            eq(documentFieldsTable.userId, userId),
            eq(documentFieldsTable.key, key),
            isNull(documentsTable.deletedAt),
          ),
        );
      return rows.map((r) => r.value).sort((a, b) => a.localeCompare(b));
    },

    async listDocumentIdsWithFields({ userId }: { userId: string }): Promise<Set<string>> {
      const rows = await db
        .selectDistinct({ documentId: documentFieldsTable.documentId })
        .from(documentFieldsTable)
        .where(eq(documentFieldsTable.userId, userId));
      return new Set(rows.map((r) => r.documentId));
    },
  };
}

export type FieldsRepository = ReturnType<typeof createFieldsRepository>;
