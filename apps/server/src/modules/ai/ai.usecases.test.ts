import { describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import pino from "pino";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { createSettingsRegistry, defineSetting } from "../settings/settings.registry.js";
import { createSettingsService, type SettingsService } from "../settings/settings.usecases.js";
import { createAiService } from "./ai.usecases.js";
import { aiSettingDefinitions } from "./ai.settings.js";
import { aiProviderRegistry } from "./providers/index.js";
import type { AiAdapter, ModelInfo, StructuredResult, TestResult } from "./ai.types.js";
import { expectAppError } from "../../shared/test/errors.test-utils.js";

const silentLogger = pino({ level: "silent" });

function fakeAdapter(overrides: Partial<AiAdapter> = {}): AiAdapter {
  return {
    generateStructured: vi.fn(async () => ({
      data: { items: [{ type: "tag", id: "t1", matched: true, confidence: 0.9, reasoning: "test" }] },
      usage: { promptTokens: 100, completionTokens: 20 },
    })),
    streamText: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() { yield "hello"; },
    })),
    streamChat: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() { yield { type: "text" as const, text: "hello" }; },
    })),
    embed: vi.fn(async () => ({ vectors: [[0.1, 0.2]], dimension: 2 })),
    recognizeImage: vi.fn(async () => ({ text: "extracted text" })),
    listModels: vi.fn(async () => [
      { id: "test-model", label: "Test Model", contextLength: 8000 },
    ] as ModelInfo[]),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 42, message: "Connected. 1 models available." }) as TestResult),
    ...overrides,
  };
}

async function setup(
  env: Record<string, string> = {},
  options: { adapter?: AiAdapter; registry?: typeof aiProviderRegistry } = {},
) {
  const { db } = await createTestDatabase();
  const registry = createSettingsRegistry(aiSettingDefinitions);
  const settingsService = createSettingsService({
    db,
    registry,
    config: { settingsEncryptionKey: "ab".repeat(32), env },
  });
  const adapter = options.adapter ?? fakeAdapter();
  const adapterFactories = {
    "openai-compatible": vi.fn(() => adapter),
    "anthropic": vi.fn(() => adapter),
  };
  const aiService = createAiService({
    settingsService,
    registry: options.registry ?? aiProviderRegistry,
    adapterFactories,
    logger: silentLogger,
  });
  return { settingsService, aiService, adapter, adapterFactories };
}

const userId = "user-1";

describe("ai service", () => {
  it("resolves a slot from settings and calls the adapter", async () => {
    const { settingsService, aiService, adapter } = await setup();
    await settingsService.set(userId, {
      "ai.openrouter.apiKey": "sk-or-v1-test",
      "ai.model.rules": "openrouter://google/gemini-2.0-flash-001",
    });
    const schema = v.object({ items: v.array(v.unknown()) });
    const result = await aiService.generateStructured({
      userId,
      task: "rules",
      schema,
      schemaName: "test",
      system: "test",
      input: "test",
    });
    expect(result.data).toBeTruthy();
    expect(adapter.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({ model: "google/gemini-2.0-flash-001" }),
    );
  });

  it("uses suggested model when slot is empty but provider key is set", async () => {
    const { settingsService, aiService, adapter } = await setup();
    await settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test" });
    // No slot set, but OpenRouter has a suggestedModels.rules
    const schema = v.object({ items: v.array(v.unknown()) });
    const result = await aiService.generateStructured({
      userId,
      task: "rules",
      schema,
      schemaName: "test",
      system: "test",
      input: "test",
    });
    expect(result.data).toBeTruthy();
    expect(adapter.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({ model: "google/gemini-3.8-flash" }),
    );
  });

  it("throws ai.slot_not_configured when no slot and no key", async () => {
    const { aiService } = await setup();
    const schema = v.object({ items: v.array(v.unknown()) });
    await expectAppError(
      () => aiService.generateStructured({ userId, task: "rules", schema, schemaName: "test", system: "test", input: "test" }),
      "ai.slot_not_configured",
    );
  });

  it("throws ai.provider_not_configured when slot set but key missing", async () => {
    const { settingsService, aiService } = await setup();
    await settingsService.set(userId, { "ai.model.rules": "openrouter://some-model" });
    const schema = v.object({ items: v.array(v.unknown()) });
    await expectAppError(
      () => aiService.generateStructured({ userId, task: "rules", schema, schemaName: "test", system: "test", input: "test" }),
      "ai.provider_not_configured",
    );
  });

  it("resolves the vision slot and delegates to the adapter", async () => {
    const { settingsService, aiService, adapter } = await setup();
    await settingsService.set(userId, {
      "ai.openrouter.apiKey": "sk-or-v1-test",
      "ai.model.vision": "openrouter://google/gemini-2.5-flash",
    });
    const image = Buffer.from("fake image bytes");
    const result = await aiService.recognizeImage({
      userId,
      image,
      mimeType: "image/png",
      prompt: "Extract all text from this document image.",
    });
    expect(result.text).toBe("extracted text");
    expect(adapter.recognizeImage).toHaveBeenCalledWith({
      model: "google/gemini-2.5-flash",
      image,
      mimeType: "image/png",
      prompt: "Extract all text from this document image.",
    });
  });

  it("throws ai.slot_not_configured for vision when no slot and no key", async () => {
    const { aiService } = await setup();
    await expectAppError(
      () =>
        aiService.recognizeImage({
          userId,
          image: Buffer.from("x"),
          mimeType: "image/png",
          prompt: "Extract all text from this document image.",
        }),
      "ai.slot_not_configured",
    );
  });

  it("resolves the chat slot and delegates to streamChat", async () => {
    const { settingsService, aiService, adapter } = await setup();
    await settingsService.set(userId, {
      "ai.openrouter.apiKey": "sk-or-v1-test",
      "ai.model.chat": "openrouter://google/gemini-2.0-flash-001",
    });
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: "You are DocMind's chat assistant." },
      { role: "user", content: "What is in the invoice?" },
    ];
    const stream = await aiService.streamChat({ userId, messages, maxTokens: 500 });
    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks.join("")).toBe("hello");
    expect(adapter.streamChat).toHaveBeenCalledWith({
      model: "google/gemini-2.0-flash-001",
      messages,
      maxTokens: 500,
    });
  });

  it("throws ai.slot_not_configured for chat when no slot and no key", async () => {
    const { aiService } = await setup();
    await expectAppError(
      () => aiService.streamChat({ userId, messages: [{ role: "user", content: "hi" }] }),
      "ai.slot_not_configured",
    );
  });

  it("appends the online suffix to the model when web search is requested on an OpenRouter slot", async () => {
    const { settingsService, aiService, adapter } = await setup();
    await settingsService.set(userId, {
      "ai.openrouter.apiKey": "sk-or-v1-test",
      "ai.model.chat": "openrouter://google/gemini-2.0-flash-001",
    });
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "user", content: "what's the weather in ottawa" },
    ];
    const stream = await aiService.streamChat({ userId, messages, web: true });
    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks.join("")).toBe("hello");
    expect(adapter.streamChat).toHaveBeenCalledWith({
      model: "google/gemini-2.0-flash-001:online",
      messages,
      maxTokens: undefined,
    });
  });

  it("refuses web search when the chat slot is not on OpenRouter", async () => {
    const { settingsService, aiService, adapter } = await setup();
    await settingsService.set(userId, {
      "ai.anthropic.apiKey": "sk-ant-test",
      "ai.model.chat": "anthropic://claude-sonnet-4-20250514",
    });
    await expectAppError(
      () => aiService.streamChat({ userId, messages: [{ role: "user", content: "hi" }], web: true }),
      "ai.web_search_unsupported",
    );
    expect(adapter.streamChat).not.toHaveBeenCalled();
  });

  it("streamChatWithTools validates a tool call's arguments against the caller's schema", async () => {
    const streamChatMock = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "text" as const, text: "One moment. " };
        yield { type: "toolCall" as const, id: "call_1", name: "saveNote", arguments: { text: "buy milk" } };
      },
    }));
    const { settingsService, aiService } = await setup({}, { adapter: fakeAdapter({ streamChat: streamChatMock }) });
    await settingsService.set(userId, {
      "ai.openrouter.apiKey": "sk-or-v1-test",
      "ai.model.chat": "openrouter://google/gemini-2.0-flash-001",
    });
    const tools = [{ name: "saveNote", description: "Saves a note.", schema: v.object({ text: v.string() }) }];
    const stream = await aiService.streamChatWithTools({ userId, messages: [{ role: "user", content: "note: buy milk" }], tools });
    const parts = [];
    for await (const part of stream) parts.push(part);
    expect(parts).toEqual([
      { type: "text", text: "One moment. " },
      { type: "toolCall", id: "call_1", name: "saveNote", arguments: { text: "buy milk" } },
    ]);
    expect(streamChatMock).toHaveBeenCalledTimes(1);
    expect(streamChatMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "google/gemini-2.0-flash-001", tools }),
    );
  });

  it("streamChatWithTools retries once with the parse error when arguments fail validation, then succeeds", async () => {
    const streamChatMock = vi
      .fn()
      .mockImplementationOnce(async () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "toolCall" as const, id: "call_1", name: "saveNote", arguments: { text: 123 } };
        },
      }))
      .mockImplementationOnce(async () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "toolCall" as const, id: "call_2", name: "saveNote", arguments: { text: "buy milk" } };
        },
      }));
    const { settingsService, aiService } = await setup({}, { adapter: fakeAdapter({ streamChat: streamChatMock }) });
    await settingsService.set(userId, {
      "ai.openrouter.apiKey": "sk-or-v1-test",
      "ai.model.chat": "openrouter://google/gemini-2.0-flash-001",
    });
    const tools = [{ name: "saveNote", description: "Saves a note.", schema: v.object({ text: v.string() }) }];
    const stream = await aiService.streamChatWithTools({ userId, messages: [{ role: "user", content: "note: buy milk" }], tools });
    const parts = [];
    for await (const part of stream) parts.push(part);
    expect(parts).toEqual([{ type: "toolCall", id: "call_2", name: "saveNote", arguments: { text: "buy milk" } }]);
    expect(streamChatMock).toHaveBeenCalledTimes(2);
    const secondCallArgs = streamChatMock.mock.calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    const lastMessage = secondCallArgs.messages.at(-1);
    expect(lastMessage?.role).toBe("user");
    expect(lastMessage?.content).toContain("invalid arguments");
  });

  it("streamChatWithTools reports ai.tool_call_invalid honestly after a second invalid attempt, without repairing anything", async () => {
    const streamChatMock = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "toolCall" as const, id: "call_1", name: "saveNote", arguments: { text: 123 } };
      },
    }));
    const { settingsService, aiService } = await setup({}, { adapter: fakeAdapter({ streamChat: streamChatMock }) });
    await settingsService.set(userId, {
      "ai.openrouter.apiKey": "sk-or-v1-test",
      "ai.model.chat": "openrouter://google/gemini-2.0-flash-001",
    });
    const tools = [{ name: "saveNote", description: "Saves a note.", schema: v.object({ text: v.string() }) }];
    await expectAppError(async () => {
      const stream = await aiService.streamChatWithTools({ userId, messages: [{ role: "user", content: "note: buy milk" }], tools });
      for await (const _part of stream) {
        // drain
      }
    }, "ai.tool_call_invalid");
    expect(streamChatMock).toHaveBeenCalledTimes(2);
  });

  it("streamChatWithTools throws ai.tools_unsupported when the provider's adapter has no tool capability", async () => {
    const registry = { ...aiProviderRegistry, openrouter: { ...aiProviderRegistry.openrouter!, capabilities: { ...aiProviderRegistry.openrouter!.capabilities, tools: false } } };
    const { settingsService, aiService } = await setup({}, { registry });
    await settingsService.set(userId, {
      "ai.openrouter.apiKey": "sk-or-v1-test",
      "ai.model.chat": "openrouter://google/gemini-2.0-flash-001",
    });
    const tools = [{ name: "saveNote", description: "Saves a note.", schema: v.object({ text: v.string() }) }];
    await expectAppError(
      () => aiService.streamChatWithTools({ userId, messages: [{ role: "user", content: "hi" }], tools }),
      "ai.tools_unsupported",
    );
  });

  it("streamChatWithTools throws ai.tools_unsupported when OpenRouter's model list reports the model does not support tools", async () => {
    const adapter = fakeAdapter({
      listModels: vi.fn(async () => [
        { id: "google/gemini-2.0-flash-001", label: "Gemini 2.0 Flash", supportsTools: false },
      ]),
    });
    const { settingsService, aiService } = await setup({}, { adapter });
    await settingsService.set(userId, {
      "ai.openrouter.apiKey": "sk-or-v1-test",
      "ai.model.chat": "openrouter://google/gemini-2.0-flash-001",
    });
    const tools = [{ name: "saveNote", description: "Saves a note.", schema: v.object({ text: v.string() }) }];
    await expectAppError(
      () => aiService.streamChatWithTools({ userId, messages: [{ role: "user", content: "hi" }], tools }),
      "ai.tools_unsupported",
    );
    expect(adapter.streamChat).not.toHaveBeenCalled();
  });

  it("supportsTools reports true for a capable provider and false when the provider or model cannot", async () => {
    const { settingsService, aiService } = await setup();
    await settingsService.set(userId, {
      "ai.openrouter.apiKey": "sk-or-v1-test",
      "ai.model.chat": "openrouter://google/gemini-2.0-flash-001",
    });
    expect(await aiService.supportsTools(userId)).toBe(true);

    const noToolsAdapter = fakeAdapter({
      listModels: vi.fn(async () => [{ id: "google/gemini-2.0-flash-001", label: "Gemini 2.0 Flash", supportsTools: false }]),
    });
    const { settingsService: settingsService2, aiService: aiService2 } = await setup({}, { adapter: noToolsAdapter });
    await settingsService2.set(userId, {
      "ai.openrouter.apiKey": "sk-or-v1-test",
      "ai.model.chat": "openrouter://google/gemini-2.0-flash-001",
    });
    expect(await aiService2.supportsTools(userId)).toBe(false);
  });

  it("lists models with cache", async () => {
    const { settingsService, aiService, adapter } = await setup();
    await settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test" });
    const r1 = await aiService.listModels(userId, "openrouter");
    const r2 = await aiService.listModels(userId, "openrouter");
    expect(r1.models).toHaveLength(1);
    expect(r2.models).toHaveLength(1);
    // Adapter should be called only once due to cache
    expect(adapter.listModels).toHaveBeenCalledTimes(1);
  });

  it("tests connection for a provider", async () => {
    const { settingsService, aiService } = await setup();
    await settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test" });
    const result = await aiService.testConnection(userId, "openrouter");
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("validates the structured response with valibot", async () => {
    const { settingsService, aiService } = await setup();
    await settingsService.set(userId, {
      "ai.openrouter.apiKey": "sk-or-v1-test",
      "ai.model.rules": "openrouter://test",
    });
    // Use a strict schema that the fake adapter's response does not match
    const schema = v.object({ wrongField: v.string() });
    await expectAppError(
      () => aiService.generateStructured({ userId, task: "rules", schema, schemaName: "test", system: "test", input: "test" }),
      "ai.invalid_response",
    );
  });
});
