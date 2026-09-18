export type SummaryJobPayload = {
  documentId: string;
  userId: string;
};

export type SummaryResult = {
  summary: string;
  suggestedTitle: string;
  documentDate: string | null;
  // Unknown on purpose: whatever the model sent, shape unchecked. normalizeFieldRows is
  // the only thing that decides what any of it means.
  fields?: unknown;
};
