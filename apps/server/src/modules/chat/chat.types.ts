import type { chatMessagesTable, chatSessionsTable } from "./chat.tables.js";

export type ChatSession = typeof chatSessionsTable.$inferSelect;
export type NewChatSession = typeof chatSessionsTable.$inferInsert;
export type ChatMessage = typeof chatMessagesTable.$inferSelect;
export type NewChatMessage = typeof chatMessagesTable.$inferInsert;

export type Citation = {
  documentId: string;
  documentName: string;
  chunkText: string;
  chunkIndex: number;
  storageDriver: string;
};

export type ChatJobPayload = {
  sessionId: string;
  userId: string;
  messageId: string;
};

// The client-facing half of a pending proposal. No arguments: the sentence is the
// rendering, and the arguments never leave the server. Defined here rather than in the
// assistant module because ChatStreamEvent carries it and chat must not import assistant.
export type PendingProposal = {
  id: string;
  tool: string;
  text: string;
  messageId: string;
  proposedAt: string;
};
