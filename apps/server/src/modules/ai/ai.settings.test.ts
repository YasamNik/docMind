import { describe, expect, it } from "vitest";
import { allSettingDefinitions } from "../settings/settings.definitions.js";
import { aiSettingDefinitions, aiSlotSettingDefinitions } from "./ai.settings.js";

describe("ai settings", () => {
  it("defines the three model slots with env seeds and empty defaults", () => {
    const keys = aiSlotSettingDefinitions.map((d) => d.key);
    expect(keys).toEqual(["ai.model.rules", "ai.model.chat", "ai.model.embedding"]);
    expect(aiSlotSettingDefinitions[0]).toMatchObject({ env: "AI_MODEL_RULES", default: "", secret: false });
    expect(aiSlotSettingDefinitions[1]).toMatchObject({ env: "AI_MODEL_CHAT", default: "", secret: false });
    expect(aiSlotSettingDefinitions[2]).toMatchObject({ env: "AI_MODEL_EMBEDDING", default: "", secret: false });
  });

  it("includes every provider's settings", () => {
    const byKey = new Map(aiSettingDefinitions.map((d) => [d.key, d]));
    expect(byKey.get("ai.openrouter.apiKey")).toMatchObject({ secret: true });
    expect(byKey.has("ai.ollama.baseUrl")).toBe(true);
    expect(byKey.has("ai.ollama.apiKey")).toBe(false);
  });

  it("is registered in the global definitions", () => {
    const keys = allSettingDefinitions.map((d) => d.key);
    expect(keys).toContain("ai.model.rules");
    expect(keys).toContain("ai.model.chat");
    expect(keys).toContain("ai.model.embedding");
    expect(keys).toContain("ai.openrouter.apiKey");
    expect(keys).toContain("ai.ollama.baseUrl");
  });
});
