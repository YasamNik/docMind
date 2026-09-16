import { describe, expect, it } from "vitest";
import { aiProviderIds, aiProviderRegistry } from "./index.js";
import { aiSettingDefinitions } from "../ai.settings.js";

describe("ai provider registry", () => {
  it("has all eight providers in display order", () => {
    expect(aiProviderIds).toEqual([
      "openrouter",
      "openai",
      "anthropic",
      "ollama",
      "mistral",
      "deepseek",
      "lmstudio",
      "custom",
    ]);
  });

  it("every provider has the required fields", () => {
    for (const id of aiProviderIds) {
      const def = aiProviderRegistry[id]!;
      expect(def.id).toBe(id);
      expect(def.label).toBeTruthy();
      expect(["openai-compatible", "anthropic"]).toContain(def.adapter);
      expect(typeof def.defaultBaseUrl).toBe("string");
      expect(typeof def.requiresKey).toBe("boolean");
      expect(def.capabilities).toMatchObject({
        text: expect.any(Boolean),
        structured: expect.any(Boolean),
        embeddings: expect.any(Boolean),
        listModels: expect.any(Boolean),
      });
      expect(def.guide.title).toBeTruthy();
      expect(def.guide.steps.length).toBeGreaterThan(0);
    }
  });

  it("only ollama and lmstudio do not require a key", () => {
    const noKey = aiProviderIds.filter((id) => !aiProviderRegistry[id]!.requiresKey);
    expect(noKey.sort()).toEqual(["lmstudio", "ollama"]);
  });

  it("only anthropic uses the anthropic adapter", () => {
    const anthropicAdapters = aiProviderIds.filter((id) => aiProviderRegistry[id]!.adapter === "anthropic");
    expect(anthropicAdapters).toEqual(["anthropic"]);
  });

  it("emits settings for every provider into aiSettingDefinitions", () => {
    const keys = aiSettingDefinitions.map((d) => d.key);
    expect(keys).toContain("ai.openrouter.apiKey");
    expect(keys).toContain("ai.openrouter.baseUrl");
    expect(keys).toContain("ai.anthropic.apiKey");
    expect(keys).toContain("ai.ollama.baseUrl");
    expect(keys).toContain("ai.custom.apiKey");
    expect(keys).toContain("ai.custom.baseUrl");
    expect(keys).toContain("ai.model.rules");
    expect(keys).toContain("ai.model.chat");
    expect(keys).toContain("ai.model.embedding");
  });

  it("marks apiKey settings as secret", () => {
    const apiKeys = aiSettingDefinitions.filter((d) => d.key.endsWith(".apiKey"));
    for (const def of apiKeys) {
      expect(def.secret).toBe(true);
    }
  });

  it("guide text contains no em dashes", () => {
    for (const id of aiProviderIds) {
      const def = aiProviderRegistry[id]!;
      const allText = [
        def.guide.title,
        def.guide.intro,
        ...def.guide.steps.map((s) => s.text),
        ...def.guide.notes,
      ].join(" ");
      expect(allText).not.toContain(String.fromCharCode(0x2014));
      expect(allText).not.toContain(String.fromCharCode(0x2013));
    }
  });
});
