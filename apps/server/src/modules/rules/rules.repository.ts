import { and, eq } from "drizzle-orm";
import type { Database } from "../database/database.js";
import { documentTagsTable } from "../tags/tags.tables.js";
import { sortEvaluationsTable } from "./rules.tables.js";
import type { NewSortEvaluation } from "./rules.types.js";

export function createRulesRepository({ db }: { db: Database }) {
  return {
    async insertEvaluations(evaluations: NewSortEvaluation[], tx: Database = db) {
      if (evaluations.length === 0) return;
      await tx.insert(sortEvaluationsTable).values(evaluations);
    },

    // Mirrors tags.repository.ts's upsertDocumentTagManual, for the applied_by_auto flag
    // instead of applied_by_manual. Duplicated rather than shared, matching the accepted
    // precedent from documents.repository.ts's own tag-chip queries (C2 plan review
    // finding 7): the two flags are written from different modules for different reasons.
    async setTagAutoApplied({
      documentId,
      tagId,
      applied,
      tx = db,
    }: {
      documentId: string;
      tagId: string;
      applied: boolean;
      tx?: Database;
    }) {
      const [existing] = await tx
        .select()
        .from(documentTagsTable)
        .where(and(eq(documentTagsTable.documentId, documentId), eq(documentTagsTable.tagId, tagId)));
      if (!existing) {
        if (!applied) return;
        await tx.insert(documentTagsTable).values({ documentId, tagId, appliedByAuto: 1, appliedByManual: 0 });
        return;
      }
      const appliedByAuto = applied ? 1 : 0;
      if (appliedByAuto === 0 && existing.appliedByManual === 0) {
        await tx.delete(documentTagsTable).where(and(eq(documentTagsTable.documentId, documentId), eq(documentTagsTable.tagId, tagId)));
        return;
      }
      await tx
        .update(documentTagsTable)
        .set({ appliedByAuto })
        .where(and(eq(documentTagsTable.documentId, documentId), eq(documentTagsTable.tagId, tagId)));
    },

    async findDocumentTag({ documentId, tagId, tx = db }: { documentId: string; tagId: string; tx?: Database }) {
      const [row] = await tx
        .select()
        .from(documentTagsTable)
        .where(and(eq(documentTagsTable.documentId, documentId), eq(documentTagsTable.tagId, tagId)));
      return row ?? null;
    },
  };
}

export type RulesRepository = ReturnType<typeof createRulesRepository>;
