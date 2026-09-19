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
});
