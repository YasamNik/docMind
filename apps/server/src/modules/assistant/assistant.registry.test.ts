import { Readable } from "node:stream";
import { toJsonSchema } from "@valibot/to-json-schema";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import type { AiAdapter, ChatStreamPart, ModelInfo, StructuredResult, TestResult } from "../ai/ai.types.js";
import { createSearchRepository } from "../search/search.repository.js";
import { missingNoteTextReply, newThreadReply } from "./assistant.models.js";
import { assistantCapabilities } from "./assistant.registry.js";
import type { ToolContext } from "./assistant.types.js";

// Wraps plain text chunks as the adapter's typed stream shape (see ai.types.ts), the
// same helper chat.usecases.test.ts and telegram.usecases.test.ts each keep their own
// copy of until Task 3 shares one (assistant.usecases plan, ai.test-utils.ts).
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
  const chatStream = streamChat ?? vi.fn(async () => asyncIterableOf(["Answer text."]));
  const adapter = fakeAdapter(chatStream);
  const t = await createTestApp({ adapterFactories: { "openai-compatible": () => adapter, "anthropic": () => adapter } });
  const { userId } = await t.signIn();
  await t.services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test", "ai.model.chat": "openrouter://test-chat-model" });
  return { t, userId, chatStream };
}

type TestApp = Awaited<ReturnType<typeof setup>>["t"];

async function uploadWithChunk(t: TestApp, userId: string, name: string, text: string) {
  const { document } = await t.services.documentsService.upload({ userId, name, mimeType: "text/plain", body: Readable.from([text]) });
  await t.db.run(sql`update documents set extracted_text = ${text}, extraction_status = 'done' where id = ${document.id}`);
  const repository = createSearchRepository({ db: t.db });
  await repository.insertChunks([{ documentId: document.id, chunkIndex: 0, chunkText: text, tokenCount: 10, startChar: 0, endChar: text.length }]);
  return document.id;
}

function buildCtx({
  t,
  userId,
  sessionId = null,
  surface = "telegram",
  userMessage = "",
  startNewThread = vi.fn(async () => {}),
  instructions = "",
}: {
  t: TestApp;
  userId: string;
  sessionId?: string | null;
  surface?: ToolContext["surface"];
  userMessage?: string;
  startNewThread?: ToolContext["startNewThread"];
  instructions?: string;
}): ToolContext {
  return {
    userId,
    sessionId,
    surface,
    userMessage,
    services: { chat: t.services.chatService, documents: t.services.documentsService, ai: t.services.aiService },
    startNewThread,
    instructions,
  };
}

describe("assistant registry, as data", () => {
  it("keys every record by its own name", () => {
    const entries = Object.entries(assistantCapabilities);
    expect(entries).toHaveLength(5);
    for (const [key, capability] of entries) expect(capability.name).toBe(key);
  });

  it("gives every record a description that says when to use it, not just what it is", () => {
    for (const capability of Object.values(assistantCapabilities)) {
      expect(capability.description.length).toBeGreaterThan(40);
      expect(capability.description.toLowerCase()).toMatch(/user|question/);
    }
  });

  it("gives every record an object schema the adapters can turn into json schema", () => {
    for (const capability of Object.values(assistantCapabilities)) {
      const jsonSchema = toJsonSchema(capability.schema) as Record<string, unknown>;
      expect(jsonSchema.type).toBe("object");
    }
  });

  it("gives startNewThread an empty object schema the adapters can send with no parameters", () => {
    const jsonSchema = toJsonSchema(assistantCapabilities.startNewThread.schema) as Record<string, unknown>;
    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.properties).toEqual({});
  });

  it("marks saveNote as the only writing tool, and nothing as destructive yet", () => {
    const writing = Object.values(assistantCapabilities).filter((c) => c.writes);
    expect(writing.map((c) => c.name)).toEqual(["saveNote"]);
    expect(Object.values(assistantCapabilities).every((c) => !c.destructive)).toBe(true);
  });

  it("has no tool that can delete anything in this plan", () => {
    for (const capability of Object.values(assistantCapabilities)) {
      expect(capability.destructive).toBe(false);
      expect(capability.description.toLowerCase()).not.toMatch(/delete|remove|purge|trash/);
    }
  });
});

describe("assistant registry, handlers", () => {
  it("saves a note as a document named from its first line", async () => {
    const { t, userId } = await setup();
    const ctx = buildCtx({ t, userId });

    const result = await assistantCapabilities.saveNote.handler({ text: "Buy milk\nAt the store" }, ctx);

    expect(result.reply).toMatch(/got it/i);
    expect(result.reply).toContain("Buy milk.txt");
    const documents = await t.services.documentsService.list({ userId });
    expect(documents).toHaveLength(1);
    expect(documents[0]?.name).toBe("Buy milk.txt");
  });

  it("does not save the same note twice, and says so", async () => {
    const { t, userId } = await setup();
    const ctx = buildCtx({ t, userId });

    await assistantCapabilities.saveNote.handler({ text: "Buy milk" }, ctx);
    const second = await assistantCapabilities.saveNote.handler({ text: "Buy milk" }, ctx);

    expect(second.reply).toMatch(/already/i);
    const documents = await t.services.documentsService.list({ userId });
    expect(documents).toHaveLength(1);
  });

  it("asks for the text instead of filing a blank note", async () => {
    const { t, userId } = await setup();
    const ctx = buildCtx({ t, userId });

    const result = await assistantCapabilities.saveNote.handler({ text: "   " }, ctx);

    expect(result.reply).toBe(missingNoteTextReply());
    const documents = await t.services.documentsService.list({ userId });
    expect(documents).toHaveLength(0);
  });

  it("answers from the documents and returns the citation it used", async () => {
    const { t, userId } = await setup(vi.fn(async () => asyncIterableOf(["The rent is $1200 [1]."])));
    const documentId = await uploadWithChunk(t, userId, "invoice.txt", "Rent is $1200 per month.");
    const session = await t.services.chatService.createSession({ userId });
    await t.services.chatService.appendUserMessage({ userId, sessionId: session.id, content: "rent per month" });
    const ctx = buildCtx({ t, userId, sessionId: session.id, surface: "app", userMessage: "rent per month" });

    const result = await assistantCapabilities.answerFromDocuments.handler({ question: "rent per month" }, ctx);

    expect(result.reply).toBe("The rent is $1200 [1].");
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.documentId).toBe(documentId);
  });

  it("carries the user's own instructions onto the answering call", async () => {
    const { t, userId } = await setup(vi.fn(async () => asyncIterableOf(["An answer."])));
    const session = await t.services.chatService.createSession({ userId });
    await t.services.chatService.appendUserMessage({ userId, sessionId: session.id, content: "anything" });
    const answerSpy = vi.spyOn(t.services.chatService, "answerFromDocuments");
    const ctx = buildCtx({ t, userId, sessionId: session.id, userMessage: "anything", instructions: "Reply in one word." });

    await assistantCapabilities.answerFromDocuments.handler({ question: "anything" }, ctx);

    expect(answerSpy).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: expect.stringContaining("Reply in one word.") }));
  });

  it("searches the web through the same answering path, with web set", async () => {
    const chatStream = vi.fn(async () => asyncIterableOf(["Sunny and 20C."]));
    const { t, userId } = await setup(chatStream);
    const session = await t.services.chatService.createSession({ userId });
    await t.services.chatService.appendUserMessage({ userId, sessionId: session.id, content: "weather today" });
    const ctx = buildCtx({ t, userId, sessionId: session.id, userMessage: "weather today" });

    const result = await assistantCapabilities.searchWeb.handler({ question: "weather today" }, ctx);

    expect(result.reply).toBe("Sunny and 20C.");
    expect(chatStream).toHaveBeenCalledWith(expect.objectContaining({ model: "test-chat-model:online" }));
  });

  it("carries the user's own instructions onto the web search's answering call too", async () => {
    const { t, userId } = await setup(vi.fn(async () => asyncIterableOf(["Sunny and 20C."])));
    const session = await t.services.chatService.createSession({ userId });
    await t.services.chatService.appendUserMessage({ userId, sessionId: session.id, content: "weather today" });
    const answerSpy = vi.spyOn(t.services.chatService, "answerFromDocuments");
    const ctx = buildCtx({ t, userId, sessionId: session.id, userMessage: "weather today", instructions: "Reply in one word." });

    await assistantCapabilities.searchWeb.handler({ question: "weather today" }, ctx);

    expect(answerSpy).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: expect.stringContaining("Reply in one word.") }));
  });

  it("says plainly that the web needs an OpenRouter chat model, instead of throwing", async () => {
    const { t, userId } = await setup();
    await t.services.settingsService.set(userId, { "ai.openai.apiKey": "sk-test", "ai.model.chat": "openai://gpt-4o" });
    const session = await t.services.chatService.createSession({ userId });
    await t.services.chatService.appendUserMessage({ userId, sessionId: session.id, content: "weather today" });
    const ctx = buildCtx({ t, userId, sessionId: session.id, userMessage: "weather today" });

    const result = await assistantCapabilities.searchWeb.handler({ question: "weather today" }, ctx);

    expect(result.reply).toMatch(/openrouter/i);
    expect(result.citations).toEqual([]);
  });

  it("starts a new thread through the surface's own callback", async () => {
    const { t, userId } = await setup();
    const startNewThread = vi.fn(async () => {});
    const ctx = buildCtx({ t, userId, startNewThread });

    const result = await assistantCapabilities.startNewThread.handler({}, ctx);

    expect(startNewThread).toHaveBeenCalledOnce();
    expect(result.reply).toBe(newThreadReply());
  });

  it("ends a clarifying question with a question mark, so the next yes counts as an answer", async () => {
    const { t, userId } = await setup();
    const ctx = buildCtx({ t, userId });

    const result = await assistantCapabilities.askUser.handler({ question: "Should I file this under Finance" }, ctx);

    expect(result.reply).toBe("Should I file this under Finance?");
  });

  it("refuses a tool that needs a session when there is none, in plain words", async () => {
    const { t, userId } = await setup();
    const ctx = buildCtx({ t, userId, sessionId: null });

    await expectAppError(
      () => assistantCapabilities.answerFromDocuments.handler({ question: "anything" }, ctx),
      "assistant.session_required",
    );
  });
});
