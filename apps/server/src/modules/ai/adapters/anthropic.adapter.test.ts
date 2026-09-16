import { describe, expect, it, vi, beforeEach } from "vitest";
import { createAnthropicAdapter } from "./anthropic.adapter.js";
import modelsFixture from "../__fixtures__/anthropic-models.json" with { type: "json" };
import structuredFixture from "../__fixtures__/anthropic-structured.json" with { type: "json" };
import errorFixture from "../__fixtures__/anthropic-error-401.json" with { type: "json" };
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
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

      const [callUrl, callInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callUrl).toBe("https://api.anthropic.com/v1/messages");
      const callHeaders = new Headers(callInit.headers);
      expect(callHeaders.get("x-api-key")).toBe("sk-ant-test-key-1234567890");
      expect(callHeaders.get("anthropic-version")).toBe("2023-06-01");

      const callBody = JSON.parse(callInit.body as string) as {
        output_config: { format: { schema: unknown } };
      };
      const expectedJsonSchema = toJsonSchema(schema);
      const { $schema: _expectedSchemaKey, ...expectedClean } = expectedJsonSchema as Record<string, unknown>;
      const expectedFormat = jsonSchemaOutputFormat({
        ...expectedClean,
        type: "object" as const,
      } as Parameters<typeof jsonSchemaOutputFormat>[0]);
      expect(callBody.output_config.format.schema).toEqual(expectedFormat.schema);
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

    it("returns not ok with a sanitized message on 401", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(errorFixture), { status: 401, headers: { "content-type": "application/json" } }),
      );
      const adapter = createAnthropicAdapter(config);
      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain("sk-ant-test-key-1234567890");
      expect(result.message).toContain("[redacted]");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
