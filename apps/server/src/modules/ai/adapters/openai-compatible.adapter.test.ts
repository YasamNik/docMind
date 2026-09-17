import { describe, expect, it, vi, beforeEach } from "vitest";
import { createOpenAiCompatibleAdapter } from "./openai-compatible.adapter.js";
import modelsFixture from "../__fixtures__/openrouter-models.json" with { type: "json" };
import completionFixture from "../__fixtures__/openrouter-completion.json" with { type: "json" };
import visionFixture from "../__fixtures__/openrouter-vision.json" with { type: "json" };
import errorFixture from "../__fixtures__/openrouter-error-401.json" with { type: "json" };
import * as v from "valibot";
import type { AdapterConfig } from "./adapter.types.js";

const config: AdapterConfig = {
  apiKey: "sk-or-v1-test",
  baseUrl: "https://openrouter.ai/api/v1",
  providerId: "openrouter",
  isOpenRouter: true,
};

// We mock the global fetch to intercept SDK calls
const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.restoreAllMocks();
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

describe("openai-compatible adapter", () => {
  describe("listModels", () => {
    it("returns normalized model info from the OpenRouter models endpoint", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(modelsFixture), { status: 200, headers: { "content-type": "application/json" } }),
      );
      const adapter = createOpenAiCompatibleAdapter(config);
      const models = await adapter.listModels();
      expect(models).toHaveLength(2);
      expect(models[0]).toMatchObject({
        id: "google/gemini-2.0-flash-001",
        label: "Google: Gemini 2.0 Flash",
        contextLength: 1048576,
        supportsStructured: true,
      });
      expect(models[1]).toMatchObject({
        id: "anthropic/claude-sonnet-4",
        supportsStructured: false,
      });

      const [callUrl, callInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callUrl).toBe("https://openrouter.ai/api/v1/models");
      expect(callInit.method).toBe("GET");
      const callHeaders = new Headers(callInit.headers);
      expect(callHeaders.get("authorization")).toBe("Bearer sk-or-v1-test");
      expect(callHeaders.get("http-referer")).toBe("https://github.com/YasamNik/docMind");
      expect(callHeaders.get("x-title")).toBe("DocMind");
    });
  });

  describe("generateStructured", () => {
    it("returns parsed data and usage from a completion", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(completionFixture), { status: 200, headers: { "content-type": "application/json" } }),
      );
      const adapter = createOpenAiCompatibleAdapter(config);
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
        model: "google/gemini-2.0-flash-001",
        system: "You are a sorter.",
        input: "Classify this document.",
        schema,
        schemaName: "sort_result",
      });
      expect(result.data).toMatchObject({
        items: [{ type: "tag", id: "tag_1", matched: true, confidence: 0.92 }],
      });
      expect(result.usage.promptTokens).toBe(450);
      expect(result.usage.completionTokens).toBe(52);

      const [callUrl, callInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
      const callHeaders = new Headers(callInit.headers);
      expect(callHeaders.get("authorization")).toBe("Bearer sk-or-v1-test");
      expect(callHeaders.get("http-referer")).toBe("https://github.com/YasamNik/docMind");
      expect(callHeaders.get("x-title")).toBe("DocMind");
      const callBody = JSON.parse(callInit.body as string) as Record<string, unknown>;
      expect(callBody.model).toBe("google/gemini-2.0-flash-001");
      expect(callBody.require_parameters).toBe(true);
      expect(callBody.response_format).toMatchObject({
        type: "json_schema",
        json_schema: { name: "sort_result", strict: true },
      });
    });
  });

  describe("recognizeImage", () => {
    it("sends the image as a base64 data URL and returns the extracted text", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(visionFixture), { status: 200, headers: { "content-type": "application/json" } }),
      );
      const adapter = createOpenAiCompatibleAdapter(config);
      const image = Buffer.from("fake image bytes");
      const result = await adapter.recognizeImage({
        model: "google/gemini-2.5-flash",
        image,
        mimeType: "image/png",
        prompt: "Extract all text from this document image.",
      });
      expect(result.text).toBe("Invoice #4471\nTotal Due: $128.50\nDate: 2026-01-15");

      const [callUrl, callInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
      const callBody = JSON.parse(callInit.body as string) as {
        model: string;
        messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
      };
      expect(callBody.model).toBe("google/gemini-2.5-flash");
      const [message] = callBody.messages;
      expect(message?.role).toBe("user");
      expect(message?.content).toEqual([
        { type: "text", text: "Extract all text from this document image." },
        { type: "image_url", image_url: { url: `data:image/png;base64,${image.toString("base64")}` } },
      ]);
    });
  });

  describe("testConnection", () => {
    it("returns ok with latency on success", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(modelsFixture), { status: 200, headers: { "content-type": "application/json" } }),
      );
      const adapter = createOpenAiCompatibleAdapter(config);
      const result = await adapter.testConnection();
      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.message).toContain("2 models");
    });

    it("returns not ok with a sanitized message on 401", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(errorFixture), { status: 401, headers: { "content-type": "application/json" } }),
      );
      const adapter = createOpenAiCompatibleAdapter(config);
      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain("sk-or-v1-");
      expect(result.message).toContain("[redacted]");
    });

    it("redacts a configured key that does not match the sk- prefix pattern", async () => {
      const mistralApiKey = "mistral-key-1234567890abcdef";
      const mistralConfig: AdapterConfig = {
        apiKey: mistralApiKey,
        baseUrl: "https://api.mistral.ai/v1",
        providerId: "mistral",
      };
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: `Invalid API key provided: ${mistralApiKey}`, type: "invalid_request_error" },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
      );
      const adapter = createOpenAiCompatibleAdapter(mistralConfig);
      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain(mistralApiKey);
      expect(result.message).toContain("[redacted]");
    });

    it("sends a one-token chat completion instead of listing models when listModels is false", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(completionFixture), { status: 200, headers: { "content-type": "application/json" } }),
      );
      const noListModelsConfig: AdapterConfig = { ...config, listModels: false };
      const adapter = createOpenAiCompatibleAdapter(noListModelsConfig);
      const result = await adapter.testConnection();
      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [callUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    });
  });
});
