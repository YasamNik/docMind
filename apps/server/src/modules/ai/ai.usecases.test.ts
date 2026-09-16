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
    embed: vi.fn(async () => ({ vectors: [[0.1, 0.2]], dimension: 2 })),
    listModels: vi.fn(async () => [
      { id: "test-model", label: "Test Model", contextLength: 8000 },
    ] as ModelInfo[]),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 42, message: "Connected. 1 models available." }) as TestResult),
    ...overrides,
  };
}

async function setup(env: Record<string, string> = {}) {
  const { db } = await createTestDatabase();
  const registry = createSettingsRegistry(aiSettingDefinitions);
  const settingsService = createSettingsService({
    db,
    registry,
    config: { settingsEncryptionKey: "ab".repeat(32), env },
  });
  const adapter = fakeAdapter();
  const adapterFactories = {
    "openai-compatible": vi.fn(() => adapter),
    "anthropic": vi.fn(() => adapter),
  };
  const aiService = createAiService({
    settingsService,
    registry: aiProviderRegistry,
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
