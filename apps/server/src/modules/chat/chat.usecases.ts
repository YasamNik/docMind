import { createError } from "../../shared/errors/errors.js";
import { createLogger, type Logger } from "../../shared/logger/logger.js";
import type { AiService } from "../ai/ai.usecases.js";
import { withoutEmDashes } from "../assistant/assistant.models.js";
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
import type { ChatMessage, ChatSession, Citation, NewChatMessage, NewChatSession, PendingProposal } from "./chat.types.js";

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

// Strips the pending proposal column from anything the chat API returns. A raw
// internal JSON blob would be a second, unparsed door onto the same state the
// assistant module's own typed routes already expose.
function presentSession(session: ChatSession) {
  const { pendingToolCall: _pendingToolCall, ...rest } = session;
  return { ...rest, documentScope: parseJsonArray<string>(session.documentScope) };
}

function presentMessage(message: ChatMessage) {
  return { ...message, citations: parseJsonArray<Citation>(message.citations) };
}

export type ChatStreamEvent =
  | { event: "token"; data: string }
  | { event: "done"; data: { citations: Citation[] } }
  | { event: "error"; data: { message: string } }
  // Carries a proposal the assistant is waiting on the user to answer. The shape ships
  // in this task; nothing emits it yet, since chat.sendMessage never calls a tool. The
  // assistant's own runTurn is the emitter, once plan 5 moves the app's chat page onto it.
  | { event: "proposal"; data: PendingProposal };

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

  // Appends the user's own turn: inserts the message, then derives the session
  // title on its first turn or just touches updatedAt on every later one. Throws
  // chat.session_not_found for a missing session, which is what lets sendMessage
  // reject before it ever returns a generator (see the comment above sendMessage).
  async function appendUserMessage({ userId, sessionId, content }: { userId: string; sessionId: string; content: string }): Promise<void> {
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
  }

  // Appends the assistant's own turn. citations are stored as json when there are
  // any, null otherwise; error is stored as given, or null on a normal answer. This
  // is the one place an assistant message is ever written, whether the turn ended
  // in an answer or in a caught failure. Returns the new message's id: a proposal
  // anchors itself to the turn that carries it (see setPendingToolCall below and
  // pendingToolCallSchema in assistant.schemas.ts), and nothing else reads this
  // return today, so adding it breaks no caller.
  async function appendAssistantMessage({
    sessionId,
    content,
    citations = [],
    error = null,
  }: {
    userId: string;
    sessionId: string;
    content: string;
    citations?: Citation[];
    error?: string | null;
  }): Promise<string> {
    const id = newMessageId();
    await repository.insertMessage({
      id,
      sessionId,
      role: "assistant",
      content,
      citations: citations.length > 0 ? JSON.stringify(citations) : null,
      error,
      createdAt: nowIso(),
    });
    return id;
  }

  // The retrieval and generation half of the RAG flow, with nothing persisted:
  // resolves the session, searches for chunks scoped to it, assembles the prompt
  // from the session's own history, and returns the model's reply as a stream plus
  // the chunks used to build it. question drives the search query; the history that
  // actually reaches the model comes from the session's own messages, so a caller
  // that wants the current turn answered appends it first (see sendMessage below,
  // and runTurn in assistant.usecases.ts).
  //
  // requireSession and search.search below run eagerly, before the returned stream
  // is ever iterated, so a bad sessionId or a failed search rejects this call
  // outright. The stream itself is a lazy async generator: aiService.streamChat is
  // only called once a consumer starts reading it. That is deliberate, and is what
  // lets sendMessage keep requireSession and the search call outside its own
  // streaming try block while still catching a generation failure inside it, exactly
  // as before this was split out (see the comment above sendMessage).
  async function answerFromDocuments({
    userId,
    sessionId,
    question,
    systemPrompt = CHAT_SYSTEM_PROMPT,
    web = false,
  }: {
    userId: string;
    sessionId: string;
    question: string;
    systemPrompt?: string;
    web?: boolean;
  }): Promise<{ stream: AsyncIterable<string>; chunks: Citation[] }> {
    const session = await requireSession(userId, sessionId);

    const documentScope = parseJsonArray<string>(session.documentScope);
    const searchResults = await searchService.search({ userId, query: question, limit: MAX_RETRIEVAL_CHUNKS });
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

    async function* lazyStream(): AsyncGenerator<string> {
      const raw = await aiService.streamChat({ userId, messages, web });
      for await (const piece of raw) yield piece;
    }

    return { stream: lazyStream(), chunks };
  }

  return {
    async createSession({ userId, documentScope }: { userId: string; documentScope?: string[] }) {
      const now = nowIso();
      const session = {
        id: newSessionId(),
        userId,
        title: null,
        documentScope: documentScope ? JSON.stringify(documentScope) : null,
        pendingToolCall: null,
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

    appendUserMessage,
    appendAssistantMessage,
    answerFromDocuments,

    // Sets, reads and conditionally clears the pending proposal column, treating its
    // value as an opaque string throughout: this module never parses it, the assistant
    // module owns what it means (Decision 7 in the assistant confirmation plan).
    // setPendingToolCall and readPendingToolCall resolve the session first, so a session
    // id belonging to someone else is chat.session_not_found rather than a silent miss.
    // Neither write touches updatedAt: a proposal is not a new message in the session
    // list's eyes, and the turn that made it already touched the row.
    async setPendingToolCall({ userId, sessionId, value }: { userId: string; sessionId: string; value: string }): Promise<void> {
      await requireSession(userId, sessionId);
      await repository.setPendingToolCall({ sessionId, value });
    },

    async readPendingToolCall({ userId, sessionId }: { userId: string; sessionId: string }): Promise<string | null> {
      const session = await requireSession(userId, sessionId);
      return session.pendingToolCall;
    },

    // One conditional update, no resolve-first check of its own: the where clause
    // already scopes by userId, and a mismatch on any part of it, wrong user, wrong
    // session, or a value that has already moved on, reads the same way, as false. True
    // means this caller is the one that cleared it.
    async clearPendingToolCall({ userId, sessionId, expected }: { userId: string; sessionId: string; expected: string }): Promise<boolean> {
      return repository.clearPendingToolCallIfMatches({ userId, sessionId, expected });
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
    //
    // appendUserMessage below runs before the try block the streaming generator
    // wraps, so a bad sessionId rejects this whole call rather than surfacing as an
    // error event. That is deliberate: chat.routes.ts awaits this call before it
    // opens the SSE response, so today a deleted session gets the in-app chat client an
    // ordinary HTTP 404 for its POST. Moving this work inside the generator's own try
    // would make sendMessage always resolve, which would turn that same request into a
    // 200 SSE stream carrying an error event instead, a client-visible protocol change
    // for the app's own chat page. Telegram has no such client to break, since it
    // consumes the generator itself and only ever shows the user a plain text reply, so
    // its recovery from a stale telegram.chatSessionId (see handleAssistantTurn in
    // telegram.usecases.ts) is handled there instead, by catching the rejection and
    // retrying once on a fresh session, rather than here.

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
      await appendUserMessage({ userId, sessionId, content });
      const { stream, chunks } = await answerFromDocuments({ userId, sessionId, question: content, systemPrompt, web });

      async function* generate(): AsyncGenerator<ChatStreamEvent> {
        try {
          let fullText = "";
          for await (const piece of stream) {
            fullText += piece;
            yield { event: "token", data: piece };
          }
          // The tokens above already streamed with whatever dash the model wrote: fixing
          // that would mean holding tokens back to rewrite one that reads across a piece
          // boundary, which is a streaming redesign this task does not make. What is
          // saved here, the only copy anyone reads back later, is guaranteed clean.
          const cleanText = withoutEmDashes(fullText);
          const matched = parseCitations(cleanText, chunks);
          await appendAssistantMessage({ userId, sessionId, content: cleanText, citations: matched });
          yield { event: "done", data: { citations: matched } };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error({ sessionId, err: errorMessage }, "Chat generation failed");
          await appendAssistantMessage({
            userId,
            sessionId,
            content: "I encountered an error while generating a response.",
            error: errorMessage.slice(0, 2000),
          });
          yield { event: "error", data: { message: errorMessage } };
        }
      }

      return generate();
    },
  };
}

export type ChatService = ReturnType<typeof createChatService>;
