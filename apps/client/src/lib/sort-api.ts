import { api } from "./api";

export type ProposalKind = "add_tag" | "remove_tag" | "set_category" | "set_type";

export type ProposalRow = {
  id: string;
  documentId: string;
  documentName: string;
  targetType: "tag" | "category" | "type";
  targetId: string;
  itemName: string;
  kind: ProposalKind;
  confidence: number;
  reasoning: string;
};

export type DryRunInput = {
  documentId: string;
  targetType: "tag" | "category" | "type";
  name: string;
  description: string;
  threshold: number;
};

export type DryRunResult = { matched: boolean; confidence: number; reasoning: string; wouldApply: boolean };

export type SortScope = "needs_review" | "all" | `category:${string}`;

export const sortApi = {
  async requestSort(documentId: string) {
    return (await api.json<{ job: { id: string; status: string } }>("POST", `/api/documents/${documentId}/sort`, {})).job;
  },
  run(targetType: "tag" | "category" | "type", targetId: string, scope: SortScope) {
    return api.json<{ count: number; jobIds: string[] }>("POST", "/api/sort/run", { targetType, targetId, scope });
  },
  async count(scope: SortScope) {
    return (await api.get<{ count: number }>(`/api/sort/count?scope=${encodeURIComponent(scope)}`)).count;
  },
  dryRun(input: DryRunInput) {
    return api.json<DryRunResult>("POST", "/api/sort/dry-run", input);
  },
  async listForDocument(documentId: string) {
    return (await api.get<{ proposals: ProposalRow[] }>(`/api/documents/${documentId}/proposals`)).proposals;
  },
  list(params: { limit?: number; cursor?: string } = {}) {
    const qs = new URLSearchParams();
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.cursor) qs.set("cursor", params.cursor);
    const q = qs.toString();
    return api.get<{ proposals: ProposalRow[]; nextCursor: string | null }>(`/api/proposals${q ? `?${q}` : ""}`);
  },
  apply(accept: string[], dismiss: string[]) {
    return api.json<{ appliedCount: number; dismissedCount: number }>("POST", "/api/proposals/apply", { accept, dismiss });
  },
  suggest() {
    return api.json<{ suggestions: RuleSuggestion[] }>("POST", "/api/sort/suggest", {});
  },
};

export type RuleSuggestion = { type: "tag" | "category" | "type"; name: string; description: string; reasoning: string };
