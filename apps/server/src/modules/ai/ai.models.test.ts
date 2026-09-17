import { describe, expect, it } from "vitest";
import { buildModelUri, MODEL_SLOTS, parseModelUri, sanitizeProviderError } from "./ai.models.js";

describe("ai models", () => {
  describe("MODEL_SLOTS", () => {
    it("lists all four model slots including vision", () => {
      expect(MODEL_SLOTS).toEqual(["rules", "chat", "embedding", "vision"]);
    });
  });

  describe("parseModelUri", () => {
    it("splits provider://model", () => {
      expect(parseModelUri("openrouter://google/gemini-2.0-flash-001")).toEqual({
        providerId: "openrouter",
        model: "google/gemini-2.0-flash-001",
      });
    });

    it("handles simple model names", () => {
      expect(parseModelUri("anthropic://claude-sonnet-4-20250514")).toEqual({
        providerId: "anthropic",
        model: "claude-sonnet-4-20250514",
      });
    });

    it("throws on missing separator", () => {
      expect(() => parseModelUri("just-a-model")).toThrow();
    });

    it("throws on empty provider or model", () => {
      expect(() => parseModelUri("://model")).toThrow();
      expect(() => parseModelUri("provider://")).toThrow();
    });
  });

  describe("buildModelUri", () => {
    it("joins provider and model", () => {
      expect(buildModelUri("openrouter", "google/gemini-2.0-flash-001")).toBe(
        "openrouter://google/gemini-2.0-flash-001",
      );
    });
  });

  describe("sanitizeProviderError", () => {
    it("redacts sk- keys", () => {
      expect(sanitizeProviderError("Invalid key sk-1234567890abcdef1234")).toBe(
        "Invalid key [redacted]",
      );
    });

    it("redacts sk-or- keys", () => {
      expect(sanitizeProviderError("Bad: sk-or-v1-abcdefghijklmnop")).toBe("Bad: [redacted]");
    });

    it("redacts sk-ant- keys", () => {
      expect(sanitizeProviderError("Error sk-ant-api03-aaaaaabbbbbbccccccdddddd is invalid")).toBe(
        "Error [redacted] is invalid",
      );
    });

    it("leaves normal text untouched", () => {
      expect(sanitizeProviderError("Rate limit exceeded")).toBe("Rate limit exceeded");
    });

    it("handles multiple keys in one message", () => {
      const msg = "Keys sk-1234567890abcdef1234 and sk-or-v1-abcdefghijklmnop both bad";
      expect(sanitizeProviderError(msg)).toBe("Keys [redacted] and [redacted] both bad");
    });
  });
});
