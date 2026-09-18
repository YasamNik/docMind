import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { documentsTable } from "../documents/documents.tables.js";

export const sortEvaluationsTable = sqliteTable(
  "sort_evaluations",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documentsTable.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    matched: integer("matched").notNull(),
    confidence: real("confidence").notNull(),
    reasoning: text("reasoning").notNull(),
    outcome: text("outcome").notNull(),
    proposalKind: text("proposal_kind"),
    modelId: text("model_id").notNull(),
    // NOT NULL per review ruling 6: dry runs are never stored, so every stored row has a job.
    jobId: text("job_id").notNull(),
    contentHash: text("content_hash"),
    evaluatedAt: text("evaluated_at").notNull(),
  },
  (t) => [
    index("sort_evaluations_document_evaluated_idx").on(t.documentId, t.evaluatedAt),
    index("sort_evaluations_target_idx").on(t.targetType, t.targetId),
    // Composite, not a single-column outcome index (review minor finding m2): the
    // proposals query filters on outcome = 'proposed' together with a document id.
    index("sort_evaluations_outcome_document_idx").on(t.outcome, t.documentId),
  ],
);

export const ruleExamplesTable = sqliteTable(
  "rule_examples",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    documentId: text("document_id")
      .notNull()
      .references(() => documentsTable.id, { onDelete: "cascade" }),
    documentSnippet: text("document_snippet").notNull(),
    signal: text("signal").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("rule_examples_target_idx").on(t.targetType, t.targetId)],
);
