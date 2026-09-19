import type { sortEvaluationsTable } from "./rules.tables.js";

export type SortEvaluation = typeof sortEvaluationsTable.$inferSelect;
export type NewSortEvaluation = typeof sortEvaluationsTable.$inferInsert;

export type TargetType = "tag" | "category" | "type";
export type EvaluationMode = "initial" | "rerun";
export type EvaluationOutcome = "applied" | "proposed" | "dismissed" | "below_threshold" | "no_match";
export type ProposalKind = "add_tag" | "remove_tag" | "set_category" | "set_type";

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
  // Full category path ("Finance / Tax / Receipts") for a category, plain name for a tag
  // or a document type.
  pathOrName: string;
  updatedAt: string;
};

// A row exactly as the model returned it. The discriminator is a plain string because
// the reply schema keeps it loose, so a model that invents a fourth value costs one row
// instead of the whole reply. splitReplyItemsByKnownType narrows these to ReplyItem.
export type RawReplyItem = { type: string; id: string; matched: boolean; confidence: number; reasoning: string };

export type ReplyItem = Omit<RawReplyItem, "type"> & { type: TargetType };

export type EvaluationResult = { item: AutomaticItem; matched: boolean; confidence: number; reasoning: string };

export type SortScope = { kind: "needs_review" } | { kind: "all" } | { kind: "category"; categoryId: string };

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
