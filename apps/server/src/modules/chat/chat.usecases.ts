import { createError } from "../../shared/errors/errors.js";
import { createLogger, type Logger } from "../../shared/logger/logger.js";
import type { AiService } from "../ai/ai.usecases.js";
import type { Database } from "../database/database.js";
import type { SearchService } from "../search/search.usecases.js";
import {
  assembleChatContext,
  CHAT_SYSTEM_PROMPT,
  deriveTitleFromMessage,
  newMessageId,
  newSessionId,
  nowIso,
  parseCitations,
  type ChatPromptMessage,
} from "./chat.models.js";
import { createChatRepository } from "./chat.repository.js";
import type { ChatMessage, ChatSession, Citation, NewChatMessage, NewChatSession } from "./chat.types.js";

// Chunks retrieved for RAG context per message. Kept local to this module: the
// remaining chat.models.ts constants (MAX_CONTEXT_CHARS, MAX_HISTORY_MESSAGES) cap the
// prompt itself, while this one caps how much search.search() is asked to return.
const MAX_RETRIEVAL_CHUNKS = 8;

function sessionNotFound(sessionId: string) {
  return createError({ code: "chat.session_not_found", message: `Chat session "${sessionId}" not found`, status: 404 });
}

function parseJsonArray<T>(raw: string | null): T[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

function presentSession(session: ChatSession) {
  return { ...session, documentScope: parseJsonArray<string>(session.documentScope) };
}

function presentMessage(message: ChatMessage) {
  return { ...message, citations: parseJsonArray<Citation>(message.citations) };
}

export type ChatStreamEvent =
  | { event: "token"; data: string }
  | { event: "done"; data: { citations: Citation[] } }
  | { event: "error"; data: { message: string } };

export function createChatService({
  db,
  aiService,
  searchService,
  logger = createLogger("chat"),
}: {
  db: Database;
  aiService: AiService;
  searchService: SearchService;
  logger?: Logger;
}) {
  const repository = createChatRepository({ db });

  async function requireSession(userId: string, sessionId: string): Promise<ChatSession> {
    const session = await repository.findSessionById({ userId, sessionId });
    if (!session) throw sessionNotFound(sessionId);
    return session;
  }

  return {
    async createSession({ userId, documentScope }: { userId: string; documentScope?: string[] }) {
      const now = nowIso();
      const session = {
        id: newSessionId(),
        userId,
        title: null,
        documentScope: documentScope ? JSON.stringify(documentScope) : null,
        createdAt: now,
        updatedAt: now,
      } satisfies NewChatSession;
      await repository.createSession(session);
      return presentSession(session);
    },

    async listSessions(userId: string) {
      const sessions = await repository.listSessions(userId);
      return sessions.map(presentSession);
    },

    async getSession({ userId, sessionId }: { userId: string; sessionId: string }) {
      const session = await requireSession(userId, sessionId);
      return presentSession(session);
    },

    async deleteSession({ userId, sessionId }: { userId: string; sessionId: string }) {
      await requireSession(userId, sessionId);
      await repository.deleteSession({ userId, sessionId });
    },

    async listMessages({ userId, sessionId }: { userId: string; sessionId: string }) {
      await requireSession(userId, sessionId);
      const messages = await repository.listMessages(sessionId);
      return messages.map(presentMessage);
    },

    // The core RAG flow. Saves the user's turn immediately, then returns an async
    // generator of SSE-shaped events: token pieces as they stream in, then a final
    // done event with the resolved citations. A generation failure is caught inside
    // the generator itself and turned into a saved error message plus an error event,
    // so a failed reply never leaves the user's turn unanswered.
    // systemPrompt defaults to the in-app document-bound prompt above. The Telegram
    // assistant passes its own sibling prompt (chat.models.ts, TELEGRAM_ASSISTANT_SYSTEM_PROMPT)
    // so it can hold an ordinary conversation instead of refusing when nothing matched,
    // while reusing this same retrieval, history and citation pipeline unchanged.
    async sendMessage({
      userId,
      sessionId,
      content,
      systemPrompt = CHAT_SYSTEM_PROMPT,
      web = false,
    }: {
      userId: string;
      sessionId: string;
      content: string;
      systemPrompt?: string;
      // Attaches OpenRouter's live web search to this one turn (see ai.usecases.ts). Only
      // the Telegram /web command sets this; the in-app chat page never does.
      web?: boolean;
    }): Promise<AsyncGenerator<ChatStreamEvent>> {
      const session = await requireSession(userId, sessionId);

      const userMessage: NewChatMessage = {
        id: newMessageId(),
        sessionId,
        role: "user",
        content,
        citations: null,
        error: null,
        createdAt: nowIso(),
      };
      await repository.insertMessage(userMessage);

      if (session.title === null) {
        await repository.updateSessionTitle({ sessionId, title: deriveTitleFromMessage(content), updatedAt: nowIso() });
      } else {
        await repository.touchSession({ sessionId, updatedAt: nowIso() });
      }

      const documentScope = parseJsonArray<string>(session.documentScope);
      const searchResults = await searchService.search({ userId, query: content, limit: MAX_RETRIEVAL_CHUNKS });
      const scoped = documentScope ? searchResults.filter((r) => documentScope.includes(r.documentId)) : searchResults;
      const chunks: Citation[] = scoped.map((r) => ({
        documentId: r.documentId,
        documentName: r.documentName,
        chunkText: r.chunkText,
        chunkIndex: r.chunkIndex,
        storageDriver: r.storageDriver,
      }));

      const priorMessages = await repository.listMessages(sessionId);
      const history: ChatPromptMessage[] = priorMessages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }));

      const messages = assembleChatContext({ systemPrompt, chunks, history });

      async function* generate(): AsyncGenerator<ChatStreamEvent> {
        try {
          const stream = await aiService.streamChat({ userId, messages, web });
          let fullText = "";
          for await (const piece of stream) {
            fullText += piece;
            yield { event: "token", data: piece };
          }
          const matched = parseCitations(fullText, chunks);
          await repository.insertMessage({
            id: newMessageId(),
            sessionId,
            role: "assistant",
            content: fullText,
            citations: matched.length > 0 ? JSON.stringify(matched) : null,
            error: null,
            createdAt: nowIso(),
          });
          yield { event: "done", data: { citations: matched } };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error({ sessionId, err: errorMessage }, "Chat generation failed");
          await repository.insertMessage({
            id: newMessageId(),
            sessionId,
            role: "assistant",
            content: "I encountered an error while generating a response.",
            citations: null,
            error: errorMessage.slice(0, 2000),
            createdAt: nowIso(),
          });
          yield { event: "error", data: { message: errorMessage } };
        }
      }

      return generate();
    },
  };
}

export type ChatService = ReturnType<typeof createChatService>;
