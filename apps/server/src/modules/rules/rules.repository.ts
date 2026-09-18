import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../database/database.js";
import { documentsTable } from "../documents/documents.tables.js";
import { documentTagsTable } from "../tags/tags.tables.js";
import { sortEvaluationsTable } from "./rules.tables.js";
import type { EvaluationOutcome, NewSortEvaluation, ProposalKind, TargetType } from "./rules.types.js";

const proposalColumns = {
  id: sortEvaluationsTable.id,
  documentId: sortEvaluationsTable.documentId,
  targetType: sortEvaluationsTable.targetType,
  targetId: sortEvaluationsTable.targetId,
  confidence: sortEvaluationsTable.confidence,
  reasoning: sortEvaluationsTable.reasoning,
  proposalKind: sortEvaluationsTable.proposalKind,
  documentName: documentsTable.name,
};

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

    async deleteEvaluationsForTarget({ targetType, targetId, tx = db }: { targetType: TargetType; targetId: string; tx?: Database }) {
      await tx.delete(sortEvaluationsTable).where(and(eq(sortEvaluationsTable.targetType, targetType), eq(sortEvaluationsTable.targetId, targetId)));
    },

    async findLastDismissed({
      documentId,
      targetType,
      targetId,
      proposalKind,
      tx = db,
    }: {
      documentId: string;
      targetType: TargetType;
      targetId: string;
      proposalKind: ProposalKind;
      tx?: Database;
    }) {
      const [row] = await tx
        .select()
        .from(sortEvaluationsTable)
        .where(
          and(
            eq(sortEvaluationsTable.documentId, documentId),
            eq(sortEvaluationsTable.targetType, targetType),
            eq(sortEvaluationsTable.targetId, targetId),
            eq(sortEvaluationsTable.proposalKind, proposalKind),
            eq(sortEvaluationsTable.outcome, "dismissed"),
          ),
        )
        .orderBy(desc(sortEvaluationsTable.evaluatedAt))
        .limit(1);
      return row ?? null;
    },

    async updateEvaluationOutcome({ id, outcome, tx = db }: { id: string; outcome: EvaluationOutcome; tx?: Database }) {
      await tx.update(sortEvaluationsTable).set({ outcome }).where(eq(sortEvaluationsTable.id, id));
    },

    async findProposalsByIds({ userId, ids }: { userId: string; ids: string[] }) {
      if (ids.length === 0) return [];
      return db
        .select({ ...proposalColumns })
        .from(sortEvaluationsTable)
        .innerJoin(documentsTable, eq(sortEvaluationsTable.documentId, documentsTable.id))
        .where(and(eq(documentsTable.userId, userId), inArray(sortEvaluationsTable.id, ids), eq(sortEvaluationsTable.outcome, "proposed")));
    },

    async listProposedForDocument({ userId, documentId }: { userId: string; documentId: string }) {
      return db
        .select({ ...proposalColumns })
        .from(sortEvaluationsTable)
        .innerJoin(documentsTable, eq(sortEvaluationsTable.documentId, documentsTable.id))
        .where(and(eq(documentsTable.userId, userId), eq(documentsTable.id, documentId), eq(sortEvaluationsTable.outcome, "proposed")))
        .orderBy(desc(sortEvaluationsTable.evaluatedAt), desc(sortEvaluationsTable.id));
    },

    async listProposedForUser(userId: string) {
      return db
        .select({ ...proposalColumns })
        .from(sortEvaluationsTable)
        .innerJoin(documentsTable, eq(sortEvaluationsTable.documentId, documentsTable.id))
        .where(and(eq(documentsTable.userId, userId), eq(sortEvaluationsTable.outcome, "proposed")))
        .orderBy(desc(sortEvaluationsTable.evaluatedAt), desc(sortEvaluationsTable.id));
    },

    async listLatestEvaluationsForDocument({ userId, documentId }: { userId: string; documentId: string }) {
      type EvalRow = {
        id: string;
        targetType: string;
        targetId: string;
        matched: number;
        confidence: number | null;
        reasoning: string | null;
        outcome: string;
        proposalKind: string | null;
        evaluatedAt: string;
      };
      return db.all<EvalRow>(sql`
        SELECT se.id, se.target_type AS targetType, se.target_id AS targetId,
               se.matched, se.confidence, se.reasoning, se.outcome,
               se.proposal_kind AS proposalKind, se.evaluated_at AS evaluatedAt
        FROM sort_evaluations se
        INNER JOIN documents d ON se.document_id = d.id
        WHERE se.document_id = ${documentId} AND d.user_id = ${userId}
          AND se.id IN (
            SELECT se2.id FROM sort_evaluations se2
            WHERE se2.document_id = se.document_id
              AND se2.target_type = se.target_type
              AND se2.target_id = se.target_id
            ORDER BY se2.evaluated_at DESC
            LIMIT 1
          )
        ORDER BY se.evaluated_at DESC
      `);
    },
  };
}

export type RulesRepository = ReturnType<typeof createRulesRepository>;
