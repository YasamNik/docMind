import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const chatSessionsTable = sqliteTable(
  "chat_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    // Nullable: derived from the first user message once it arrives (see
    // deriveTitleFromMessage in chat.models.ts).
    title: text("title"),
    // Nullable JSON array of document ids. Null means the chat is scoped to all
    // documents. Set at session creation and immutable afterward.
    documentScope: text("document_scope"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("chat_sessions_user_idx").on(t.userId)],
);

export const chatMessagesTable = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessionsTable.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    // Nullable JSON array of Citation objects (see chat.types.ts). Null for user
    // messages and for assistant messages that cited nothing.
    citations: text("citations"),
    // Nullable. Set when a generation attempt failed, so the assistant turn is
    // never left dangling without a saved response.
    error: text("error"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("chat_messages_session_created_idx").on(t.sessionId, t.createdAt)],
);
