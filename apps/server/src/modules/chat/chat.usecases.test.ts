import { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import type { AiAdapter, ChatStreamPart, ModelInfo, StructuredResult, TestResult } from "../ai/ai.types.js";
import { createSearchRepository } from "../search/search.repository.js";
import { deriveTitleFromMessage } from "./chat.models.js";
import type { ChatStreamEvent } from "./chat.usecases.js";

// Wraps plain text chunks as the adapter's typed stream shape (see ai.types.ts). Chat
// itself only ever gets plain text back from aiService.streamChat, which unwraps this,
// so these tests still assert on plain concatenated strings.
function asyncIterableOf(chunks: string[]): AsyncIterable<ChatStreamPart> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield { type: "text", text: chunk };
    },
  };
}

function fakeAdapter(streamChat: AiAdapter["streamChat"]): AiAdapter {
  return {
    generateStructured: vi.fn(async () => ({ data: {}, usage: { promptTokens: 0, completionTokens: 0 } }) as StructuredResult),
    streamText: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    streamChat,
    embed: vi.fn(async () => ({ vectors: [], dimension: 0 })),
    recognizeImage: vi.fn(async () => ({ text: "" })),
    listModels: vi.fn(async () => [] as ModelInfo[]),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1, message: "ok" }) as TestResult),
  };
}

async function setup(streamChat?: AiAdapter["streamChat"]) {
  const chatStream =
    streamChat ?? vi.fn(async () => asyncIterableOf(["The rent is", " $1200 per month", " [1]."]));
  const adapter = fakeAdapter(chatStream);
  const t = await createTestApp({ adapterFactories: { "openai-compatible": () => adapter, "anthropic": () => adapter } });
  const { userId } = await t.signIn();
  await t.services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test", "ai.model.chat": "openrouter://test-chat-model" });
  return { t, userId, chatStream };
}

async function uploadWithChunk(t: Awaited<ReturnType<typeof setup>>["t"], userId: string, name: string, text: string) {
  const { document } = await t.services.documentsService.upload({ userId, name, mimeType: "text/plain", body: Readable.from([text]) });
  await t.db.run(sql`update documents set extracted_text = ${text}, extraction_status = 'done' where id = ${document.id}`);
  const repository = createSearchRepository({ db: t.db });
  await repository.insertChunks([{ documentId: document.id, chunkIndex: 0, chunkText: text, tokenCount: 10, startChar: 0, endChar: text.length }]);
  return document.id;
}

async function collectEvents(generator: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const piece of stream) text += piece;
  return text;
}

describe("chat service, session CRUD", () => {
  it("creates a session and lists it", async () => {
    const { t, userId } = await setup();
    const session = await t.services.chatService.createSession({ userId });
    expect(session.title).toBeNull();
    expect(session.documentScope).toBeNull();

    const sessions = await t.services.chatService.listSessions(userId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(session.id);
  });

  it("stores the document scope as a parsed array", async () => {
    const { t, userId } = await setup();
    const documentId = await uploadWithChunk(t, userId, "invoice.txt", "Rent is $1200 per month.");
    const session = await t.services.chatService.createSession({ userId, documentScope: [documentId] });
    expect(session.documentScope).toEqual([documentId]);

    const fetched = await t.services.chatService.getSession({ userId, sessionId: session.id });
    expect(fetched.documentScope).toEqual([documentId]);
  });

  it("throws chat.session_not_found for a missing session", async () => {
    const { t, userId } = await setup();
    await expectAppError(() => t.services.chatService.getSession({ userId, sessionId: "sess_0000000000000000" }), "chat.session_not_found");
  });

  it("deletes a session and cascades its messages", async () => {
    const { t, userId } = await setup();
    const session = await t.services.chatService.createSession({ userId });
    const generator = await t.services.chatService.sendMessage({ userId, sessionId: session.id, content: "How much is my rent?" });
    await collectEvents(generator);

    await t.services.chatService.deleteSession({ userId, sessionId: session.id });

    await expectAppError(() => t.services.chatService.getSession({ userId, sessionId: session.id }), "chat.session_not_found");
    const remaining = await t.db.all(sql`select id from chat_messages where session_id = ${session.id}`);
    expect(remaining).toHaveLength(0);
  });
});

describe("chat service, sendMessage", () => {
  it("streams the response and saves it with citations", async () => {
    const { t, userId } = await setup();
    const documentId = await uploadWithChunk(t, userId, "invoice.txt", "Rent is $1200 per month.");
    const session = await t.services.chatService.createSession({ userId });

    const generator = await t.services.chatService.sendMessage({ userId, sessionId: session.id, content: "rent per month" });
    const events = await collectEvents(generator);

    const tokenEvents = events.filter((e) => e.event === "token");
    expect(tokenEvents.map((e) => e.data).join("")).toBe("The rent is $1200 per month [1].");

    const doneEvent = events.at(-1);
    expect(doneEvent?.event).toBe("done");
    if (doneEvent?.event !== "done") throw new Error("expected a done event");
    expect(doneEvent.data.citations).toHaveLength(1);
    expect(doneEvent.data.citations[0]).toMatchObject({ documentId, documentName: "invoice.txt" });

    const messages = await t.services.chatService.listMessages({ userId, sessionId: session.id });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content: "rent per month" });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "The rent is $1200 per month [1].", error: null });
    expect(messages[1]?.citations).toHaveLength(1);
  });

  it("derives the session title from the first message", async () => {
    const { t, userId } = await setup();
    const session = await t.services.chatService.createSession({ userId });
    const content = "What are the exact renewal terms and penalty clauses in my lease?";

    const generator = await t.services.chatService.sendMessage({ userId, sessionId: session.id, content });
    await collectEvents(generator);

    const afterFirst = await t.services.chatService.getSession({ userId, sessionId: session.id });
    expect(afterFirst.title).toBe(deriveTitleFromMessage(content));

    const secondGenerator = await t.services.chatService.sendMessage({ userId, sessionId: session.id, content: "And the deposit?" });
    await collectEvents(secondGenerator);
    const afterSecond = await t.services.chatService.getSession({ userId, sessionId: session.id });
    expect(afterSecond.title).toBe(deriveTitleFromMessage(content));
  });

  it("saves an error assistant message when generation fails", async () => {
    const throwingStreamChat = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const { t, userId } = await setup(throwingStreamChat as unknown as AiAdapter["streamChat"]);
    const session = await t.services.chatService.createSession({ userId });

    const generator = await t.services.chatService.sendMessage({ userId, sessionId: session.id, content: "How much is my rent?" });
    const events = await collectEvents(generator);

    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("error");
    if (events[0]?.event !== "error") throw new Error("expected an error event");
    expect(events[0].data.message).toContain("model unavailable");

    const messages = await t.services.chatService.listMessages({ userId, sessionId: session.id });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "assistant", content: "I encountered an error while generating a response." });
    expect(messages[1]?.error).toContain("model unavailable");
    expect(messages[1]?.citations).toBeNull();
  });

  it("restricts search results to the session's document scope", async () => {
    const { t, userId } = await setup();
    const scopedDoc = await uploadWithChunk(t, userId, "lease.txt", "Rent is $1200 per month.");
    await uploadWithChunk(t, userId, "other.txt", "Rent is $1200 per month too.");
    const session = await t.services.chatService.createSession({ userId, documentScope: [scopedDoc] });

    const generator = await t.services.chatService.sendMessage({ userId, sessionId: session.id, content: "rent per month" });
    const events = await collectEvents(generator);
    const doneEvent = events.at(-1);
    if (doneEvent?.event !== "done") throw new Error("expected a done event");
    expect(doneEvent.data.citations).toHaveLength(1);
    expect(doneEvent.data.citations[0]?.documentId).toBe(scopedDoc);
  });

  it("throws chat.session_not_found for a missing session", async () => {
    const { t, userId } = await setup();
    await expectAppError(() => t.services.chatService.sendMessage({ userId, sessionId: "sess_0000000000000000", content: "Hi" }), "chat.session_not_found");
  });

  // withoutEmDashes runs once the full reply is assembled, not on each streamed token
  // (assistant.models.ts): the tokens carry the raw dash while they stream, and only the
  // saved message is guaranteed clean. Plan 5 moves this page onto runTurn, where every
  // reply already goes through this on the way out.
  it("saves the assistant reply with em and en dashes turned into readable punctuation", async () => {
    const streamChat = vi.fn(async () => asyncIterableOf(["The lease runs 2020", "–2024", " — renewal terms apply."]));
    const { t, userId } = await setup(streamChat as unknown as AiAdapter["streamChat"]);
    const session = await t.services.chatService.createSession({ userId });

    const generator = await t.services.chatService.sendMessage({ userId, sessionId: session.id, content: "lease term" });
    const events = await collectEvents(generator);

    const tokenText = events.filter((e) => e.event === "token").map((e) => e.data).join("");
    expect(tokenText).toContain("—");

    const messages = await t.services.chatService.listMessages({ userId, sessionId: session.id });
    expect(messages[1]?.content).not.toMatch(/[–—]/);
    expect(messages[1]?.content).toBe("The lease runs 2020-2024, renewal terms apply.");
  });
});

describe("chat service, answerFromDocuments", () => {
  it("answers from the documents without writing anything to the session", async () => {
    const { t, userId } = await setup();
    await uploadWithChunk(t, userId, "invoice.txt", "Rent is $1200 per month.");
    const session = await t.services.chatService.createSession({ userId });
    await t.services.chatService.appendUserMessage({ userId, sessionId: session.id, content: "rent per month" });
    const before = await t.services.chatService.listMessages({ userId, sessionId: session.id });

    const { stream, chunks } = await t.services.chatService.answerFromDocuments({
      userId,
      sessionId: session.id,
      question: "rent per month",
    });
    const text = await drain(stream);

    expect(text).toBe("The rent is $1200 per month [1].");
    expect(chunks).toHaveLength(1);

    const after = await t.services.chatService.listMessages({ userId, sessionId: session.id });
    expect(after).toHaveLength(before.length);
  });

  it("keeps a document-scoped session narrow", async () => {
    const { t, userId } = await setup();
    const scopedDoc = await uploadWithChunk(t, userId, "lease.txt", "Rent is $1200 per month.");
    await uploadWithChunk(t, userId, "other.txt", "Rent is $1200 per month too.");
    const session = await t.services.chatService.createSession({ userId, documentScope: [scopedDoc] });
    await t.services.chatService.appendUserMessage({ userId, sessionId: session.id, content: "rent per month" });

    const { chunks } = await t.services.chatService.answerFromDocuments({
      userId,
      sessionId: session.id,
      question: "rent per month",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.documentId).toBe(scopedDoc);
  });

  it("rejects an unknown session with chat.session_not_found, before any model call", async () => {
    const { t, userId, chatStream } = await setup();
    await expectAppError(
      () => t.services.chatService.answerFromDocuments({ userId, sessionId: "sess_0000000000000000", question: "Hi" }),
      "chat.session_not_found",
    );
    expect(chatStream).not.toHaveBeenCalled();
  });

  it("passes web through to the model call and not otherwise", async () => {
    const { t, userId, chatStream } = await setup();
    const session = await t.services.chatService.createSession({ userId });
    await t.services.chatService.appendUserMessage({ userId, sessionId: session.id, content: "hi" });

    const withWeb = await t.services.chatService.answerFromDocuments({ userId, sessionId: session.id, question: "hi", web: true });
    await drain(withWeb.stream);
    expect(chatStream).toHaveBeenCalledWith(expect.objectContaining({ model: "test-chat-model:online" }));

    chatStream.mockClear();
    await t.services.chatService.appendUserMessage({ userId, sessionId: session.id, content: "hi again" });
    const withoutWeb = await t.services.chatService.answerFromDocuments({ userId, sessionId: session.id, question: "hi again" });
    await drain(withoutWeb.stream);
    expect(chatStream).toHaveBeenCalledWith(expect.objectContaining({ model: "test-chat-model" }));
  });

  it("stores citations as json and an error string on the assistant turn", async () => {
    const { t, userId } = await setup();
    const documentId = await uploadWithChunk(t, userId, "invoice.txt", "Rent is $1200 per month.");
    const session = await t.services.chatService.createSession({ userId });

    const { chunks } = await t.services.chatService.answerFromDocuments({
      userId,
      sessionId: session.id,
      question: "rent per month",
    });

    await t.services.chatService.appendAssistantMessage({
      userId,
      sessionId: session.id,
      content: "The rent is $1200 per month [1].",
      citations: chunks,
    });
    const afterAnswer = await t.services.chatService.listMessages({ userId, sessionId: session.id });
    expect(afterAnswer).toHaveLength(1);
    expect(afterAnswer[0]?.citations).toHaveLength(1);
    expect(afterAnswer[0]?.citations?.[0]?.documentId).toBe(documentId);

    await t.services.chatService.appendAssistantMessage({ userId, sessionId: session.id, content: "trouble", citations: [], error: "boom" });
    const afterError = await t.services.chatService.listMessages({ userId, sessionId: session.id });
    expect(afterError[1]?.citations).toBeNull();
    expect(afterError[1]?.error).toBe("boom");
  });
});

describe("chat service, the pending tool call column", () => {
  it("remembers one pending tool call on a session and reads it back", async () => {
    const { t, userId } = await setup();
    const session = await t.services.chatService.createSession({ userId });

    await t.services.chatService.setPendingToolCall({ userId, sessionId: session.id, value: "prop_a" });

    expect(await t.services.chatService.readPendingToolCall({ userId, sessionId: session.id })).toBe("prop_a");
  });

  it("clears it only for the caller that read that exact value", async () => {
    const { t, userId } = await setup();
    const session = await t.services.chatService.createSession({ userId });
    await t.services.chatService.setPendingToolCall({ userId, sessionId: session.id, value: "prop_a" });

    const first = await t.services.chatService.clearPendingToolCall({ userId, sessionId: session.id, expected: "prop_a" });
    expect(first).toBe(true);

    const second = await t.services.chatService.clearPendingToolCall({ userId, sessionId: session.id, expected: "prop_a" });
    expect(second).toBe(false);

    expect(await t.services.chatService.readPendingToolCall({ userId, sessionId: session.id })).toBeNull();
  });

  it("refuses to clear a pending call that has already been replaced", async () => {
    const { t, userId } = await setup();
    const session = await t.services.chatService.createSession({ userId });
    await t.services.chatService.setPendingToolCall({ userId, sessionId: session.id, value: "prop_a" });
    await t.services.chatService.setPendingToolCall({ userId, sessionId: session.id, value: "prop_b" });

    const cleared = await t.services.chatService.clearPendingToolCall({ userId, sessionId: session.id, expected: "prop_a" });

    expect(cleared).toBe(false);
    expect(await t.services.chatService.readPendingToolCall({ userId, sessionId: session.id })).toBe("prop_b");
  });

  it("returns the id of the assistant message it appended", async () => {
    const { t, userId } = await setup();
    const session = await t.services.chatService.createSession({ userId });

    const messageId = await t.services.chatService.appendAssistantMessage({ userId, sessionId: session.id, content: "Save that as a note?" });

    const messages = await t.services.chatService.listMessages({ userId, sessionId: session.id });
    expect(messages.some((message) => message.id === messageId)).toBe(true);
  });

  it("keeps the pending call out of every session the API returns", async () => {
    const { t, userId } = await setup();
    const session = await t.services.chatService.createSession({ userId });
    await t.services.chatService.setPendingToolCall({ userId, sessionId: session.id, value: "prop_a" });

    const fetched = await t.services.chatService.getSession({ userId, sessionId: session.id });
    expect(fetched).not.toHaveProperty("pendingToolCall");

    const list = await t.services.chatService.listSessions(userId);
    expect(list.find((s) => s.id === session.id)).not.toHaveProperty("pendingToolCall");

    const created = await t.services.chatService.createSession({ userId });
    expect(created).not.toHaveProperty("pendingToolCall");
  });

  it("rejects a pending write against another user's session", async () => {
    const { t, userId } = await setup();
    const session = await t.services.chatService.createSession({ userId });
    const otherUserId = "user_other";

    await expectAppError(
      () => t.services.chatService.setPendingToolCall({ userId: otherUserId, sessionId: session.id, value: "prop_a" }),
      "chat.session_not_found",
    );
  });

  it("reads null for a session that has never had one", async () => {
    const { t, userId } = await setup();
    const session = await t.services.chatService.createSession({ userId });

    expect(await t.services.chatService.readPendingToolCall({ userId, sessionId: session.id })).toBeNull();
  });
});
