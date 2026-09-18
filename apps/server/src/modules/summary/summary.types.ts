export type SummaryJobPayload = {
  documentId: string;
  userId: string;
};

export type SummaryResult = {
  summary: string;
  suggestedTitle: string;
  documentDate: string | null;
};
