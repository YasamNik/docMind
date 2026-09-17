import { describe, expect, it } from "vitest";
import { allSettingDefinitions } from "../settings/settings.definitions.js";
import { aiSettingDefinitions, aiSlotSettingDefinitions } from "./ai.settings.js";

describe("ai settings", () => {
  it("defines the four model slots with env seeds and empty defaults", () => {
    const keys = aiSlotSettingDefinitions.map((d) => d.key);
    expect(keys).toEqual(["ai.model.rules", "ai.model.chat", "ai.model.embedding", "ai.model.vision"]);
    expect(aiSlotSettingDefinitions[0]).toMatchObject({ env: "AI_MODEL_RULES", default: "", secret: false });
    expect(aiSlotSettingDefinitions[1]).toMatchObject({ env: "AI_MODEL_CHAT", default: "", secret: false });
    expect(aiSlotSettingDefinitions[2]).toMatchObject({ env: "AI_MODEL_EMBEDDING", default: "", secret: false });
    expect(aiSlotSettingDefinitions[3]).toMatchObject({ env: "AI_MODEL_VISION", default: "", secret: false });
  });

  it("includes every provider's settings", () => {
    const byKey = new Map(aiSettingDefinitions.map((d) => [d.key, d]));
    expect(byKey.get("ai.openrouter.apiKey")).toMatchObject({ secret: true });
    expect(byKey.has("ai.ollama.baseUrl")).toBe(true);
    expect(byKey.has("ai.ollama.apiKey")).toBe(false);
  });

  it("defines the OCR confidence threshold as a non-internal number setting with a default of 60", () => {
    const byKey = new Map(aiSettingDefinitions.map((d) => [d.key, d]));
    const threshold = byKey.get("ai.vision.ocrConfidenceThreshold");
    expect(threshold).toMatchObject({
      env: "AI_VISION_OCR_CONFIDENCE_THRESHOLD",
      default: 60,
      secret: false,
      internal: false,
    });
  });

  it("is registered in the global definitions", () => {
    const keys = allSettingDefinitions.map((d) => d.key);
    expect(keys).toContain("ai.model.rules");
    expect(keys).toContain("ai.model.chat");
    expect(keys).toContain("ai.model.embedding");
    expect(keys).toContain("ai.model.vision");
    expect(keys).toContain("ai.vision.ocrConfidenceThreshold");
    expect(keys).toContain("ai.openrouter.apiKey");
    expect(keys).toContain("ai.ollama.baseUrl");
  });
});
