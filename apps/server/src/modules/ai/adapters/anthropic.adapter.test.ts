import { describe, expect, it, vi, beforeEach } from "vitest";
import { createAnthropicAdapter } from "./anthropic.adapter.js";
import modelsFixture from "../__fixtures__/anthropic-models.json" with { type: "json" };
import structuredFixture from "../__fixtures__/anthropic-structured.json" with { type: "json" };
import * as v from "valibot";
import type { AdapterConfig } from "./adapter.types.js";

const config: AdapterConfig = {
  apiKey: "sk-ant-test-key-1234567890",
  baseUrl: "https://api.anthropic.com",
  providerId: "anthropic",
};

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.restoreAllMocks();
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

describe("anthropic adapter", () => {
  describe("listModels", () => {
    it("returns normalized model info from the Anthropic models endpoint", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(modelsFixture), { status: 200, headers: { "content-type": "application/json" } }),
      );
      const adapter = createAnthropicAdapter(config);
      const models = await adapter.listModels();
      expect(models).toHaveLength(2);
      expect(models[0]).toMatchObject({
        id: "claude-sonnet-4-20250514",
        label: "Claude Sonnet 4",
        contextLength: 200000,
      });
    });
  });

  describe("generateStructured", () => {
    it("returns parsed data and usage", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(structuredFixture), { status: 200, headers: { "content-type": "application/json" } }),
      );
      const adapter = createAnthropicAdapter(config);
      const schema = v.object({
        items: v.array(v.object({
          type: v.picklist(["tag", "category"]),
          id: v.string(),
          matched: v.boolean(),
          confidence: v.number(),
          reasoning: v.string(),
        })),
      });
      const result = await adapter.generateStructured({
        model: "claude-sonnet-4-20250514",
        system: "You are a sorter.",
        input: "Classify this document.",
        schema,
        schemaName: "sort_result",
      });
      expect(result.data).toMatchObject({
        items: [{ type: "category", id: "cat_1", matched: true, confidence: 0.88 }],
      });
      expect(result.usage.promptTokens).toBe(380);
      expect(result.usage.completionTokens).toBe(65);
    });
  });

  describe("embed", () => {
    it("throws ai.unsupported", async () => {
      const adapter = createAnthropicAdapter(config);
      await expect(adapter.embed({ model: "any", texts: ["hello"] })).rejects.toMatchObject({ code: "ai.unsupported" });
    });
  });

  describe("testConnection", () => {
    it("returns ok with latency on success", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(modelsFixture), { status: 200, headers: { "content-type": "application/json" } }),
      );
      const adapter = createAnthropicAdapter(config);
      const result = await adapter.testConnection();
      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.message).toContain("2 models");
    });
  });
});
