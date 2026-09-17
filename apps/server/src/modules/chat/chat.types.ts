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
};

export type ChatJobPayload = {
  sessionId: string;
  userId: string;
  messageId: string;
};
