import type { sortEvaluationsTable } from "./rules.tables.js";

export type SortEvaluation = typeof sortEvaluationsTable.$inferSelect;
export type NewSortEvaluation = typeof sortEvaluationsTable.$inferInsert;

export type TargetType = "tag" | "category";
export type EvaluationMode = "initial" | "rerun";
export type EvaluationOutcome = "applied" | "proposed" | "dismissed" | "below_threshold" | "no_match";
export type ProposalKind = "add_tag" | "remove_tag" | "set_category";

export type RulesJobPayload = {
  documentId: string;
  userId: string;
  mode: EvaluationMode;
  targetType?: TargetType;
  targetId?: string;
};

export type AutomaticItem = {
  type: TargetType;
  id: string;
  name: string;
  description: string;
  confidenceThreshold: number;
  // Full category path ("Finance / Tax / Receipts") for a category, plain name for a tag.
  pathOrName: string;
  updatedAt: string;
};

export type ReplyItem = { type: TargetType; id: string; matched: boolean; confidence: number; reasoning: string };

export type EvaluationResult = { item: AutomaticItem; matched: boolean; confidence: number; reasoning: string };

export type Proposal = {
  id: string;
  documentId: string;
  documentName: string;
  targetType: TargetType;
  targetId: string;
  itemName: string;
  kind: ProposalKind;
  confidence: number;
  reasoning: string;
};
