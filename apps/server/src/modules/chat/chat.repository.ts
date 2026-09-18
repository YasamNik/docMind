import { and, asc, desc, eq } from "drizzle-orm";
import type { Database } from "../database/database.js";
import { chatMessagesTable, chatSessionsTable } from "./chat.tables.js";
import type { ChatMessage, ChatSession, NewChatMessage, NewChatSession } from "./chat.types.js";

export function createChatRepository({ db }: { db: Database }) {
  return {
    async createSession(session: NewChatSession): Promise<void> {
      await db.insert(chatSessionsTable).values(session);
    },

    async findSessionById({ userId, sessionId }: { userId: string; sessionId: string }): Promise<ChatSession | null> {
      const rows = await db
        .select()
        .from(chatSessionsTable)
        .where(and(eq(chatSessionsTable.id, sessionId), eq(chatSessionsTable.userId, userId)));
      return rows[0] ?? null;
    },

    async listSessions(userId: string): Promise<ChatSession[]> {
      return db
        .select()
        .from(chatSessionsTable)
        .where(eq(chatSessionsTable.userId, userId))
        .orderBy(desc(chatSessionsTable.updatedAt));
    },

    async deleteSession({ userId, sessionId }: { userId: string; sessionId: string }): Promise<void> {
      await db.delete(chatSessionsTable).where(and(eq(chatSessionsTable.id, sessionId), eq(chatSessionsTable.userId, userId)));
    },

    async updateSessionTitle({ sessionId, title, updatedAt }: { sessionId: string; title: string; updatedAt: string }): Promise<void> {
      await db.update(chatSessionsTable).set({ title, updatedAt }).where(eq(chatSessionsTable.id, sessionId));
    },

    async touchSession({ sessionId, updatedAt }: { sessionId: string; updatedAt: string }): Promise<void> {
      await db.update(chatSessionsTable).set({ updatedAt }).where(eq(chatSessionsTable.id, sessionId));
    },

    async insertMessage(message: NewChatMessage): Promise<void> {
      await db.insert(chatMessagesTable).values(message);
    },

    async listMessages(sessionId: string): Promise<ChatMessage[]> {
      return db
        .select()
        .from(chatMessagesTable)
        .where(eq(chatMessagesTable.sessionId, sessionId))
        .orderBy(asc(chatMessagesTable.createdAt));
    },

    async findMessageById(messageId: string): Promise<ChatMessage | null> {
      const rows = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, messageId));
      return rows[0] ?? null;
    },
  };
}

export type ChatRepository = ReturnType<typeof createChatRepository>;
