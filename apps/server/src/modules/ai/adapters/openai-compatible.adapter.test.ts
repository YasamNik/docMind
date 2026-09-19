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

// Builds a chat.completions streaming response body: one SSE "data:" line per chunk,
// terminated with the [DONE] sentinel the OpenAI wire format uses.
function sseCompletionResponse(deltas: string[]): Response {
  const lines = deltas.map((content, index) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "test-model",
      choices: [{ index: 0, delta: { content }, finish_reason: index === deltas.length - 1 ? "stop" : null }],
    })}\n\n`,
  );
  lines.push("data: [DONE]\n\n");
  const body = lines.join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// Builds a chat.completions streaming response from raw per-chunk deltas, for tests
// that need control over exactly what each SSE frame carries: a tool call's id and
// name arrive on one delta, its arguments are split across several more.
function sseRawChunksResponse(deltas: Array<{ content?: string | null; tool_calls?: unknown[] }>, finishReason: string): Response {
  const lines = deltas.map((delta, index) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "test-model",
      choices: [{ index: 0, delta, finish_reason: index === deltas.length - 1 ? finishReason : null }],
    })}\n\n`,
  );
  lines.push("data: [DONE]\n\n");
  return new Response(lines.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

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
        supportsTools: true,
      });
      expect(models[1]).toMatchObject({
        id: "anthropic/claude-sonnet-4",
        supportsStructured: false,
        supportsTools: false,
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

  describe("streamChat", () => {
    it("yields the concatenated delta text from a multi-turn conversation", async () => {
      mockFetch.mockResolvedValueOnce(sseCompletionResponse(["Hel", "lo", " world"]));
      const adapter = createOpenAiCompatibleAdapter(config);
      const stream = await adapter.streamChat({
        model: "google/gemini-2.0-flash-001",
        messages: [
          { role: "system", content: "You are DocMind's chat assistant." },
          { role: "user", content: "What is the invoice total?" },
          { role: "assistant", content: "It is $128.50." },
          { role: "user", content: "And the due date?" },
        ],
        maxTokens: 500,
      });
      const parts = [];
      for await (const part of stream) parts.push(part);
      expect(parts.every((p) => p.type === "text")).toBe(true);
      expect(parts.map((p) => (p.type === "text" ? p.text : "")).join("")).toBe("Hello world");

      const [callUrl, callInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
      const callBody = JSON.parse(callInit.body as string) as {
        model: string;
        stream: boolean;
        max_tokens: number;
        messages: Array<{ role: string; content: string }>;
      };
      expect(callBody.model).toBe("google/gemini-2.0-flash-001");
      expect(callBody.stream).toBe(true);
      expect(callBody.max_tokens).toBe(500);
      expect(callBody.messages).toEqual([
        { role: "system", content: "You are DocMind's chat assistant." },
        { role: "user", content: "What is the invoice total?" },
        { role: "assistant", content: "It is $128.50." },
        { role: "user", content: "And the due date?" },
      ]);
    });

    it("sends a tools array built from the schema and assembles a tool call from fragmented deltas", async () => {
      // Realistic wire shape: the first delta for an index carries the id and name with
      // an empty arguments string, then the arguments arrive split across three more
      // deltas that only form valid JSON once concatenated.
      mockFetch.mockResolvedValueOnce(
        sseRawChunksResponse(
          [
            { content: "Sure, one moment. " },
            { tool_calls: [{ index: 0, id: "call_abc123", type: "function", function: { name: "searchWeb", arguments: "" } }] },
            { tool_calls: [{ index: 0, function: { arguments: "{\"query\":\"invoices " } }] },
            { tool_calls: [{ index: 0, function: { arguments: "over $100\"," } }] },
            { tool_calls: [{ index: 0, function: { arguments: "\"limit\":5}" } }] },
          ],
          "tool_calls",
        ),
      );
      const adapter = createOpenAiCompatibleAdapter(config);
      const schema = v.object({ query: v.string(), limit: v.number() });
      const stream = await adapter.streamChat({
        model: "google/gemini-2.0-flash-001",
        messages: [{ role: "user", content: "find invoices over $100" }],
        tools: [{ name: "searchWeb", description: "Searches the web.", schema }],
      });
      const parts = [];
      for await (const part of stream) parts.push(part);
      expect(parts).toEqual([
        { type: "text", text: "Sure, one moment. " },
        { type: "toolCall", id: "call_abc123", name: "searchWeb", arguments: { query: "invoices over $100", limit: 5 } },
      ]);

      const [, callInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      const callBody = JSON.parse(callInit.body as string) as { tools: Array<{ type: string; function: { name: string; description: string } }> };
      expect(callBody.tools).toHaveLength(1);
      expect(callBody.tools[0]).toMatchObject({ type: "function", function: { name: "searchWeb", description: "Searches the web." } });
    });

    it("keys concurrent tool calls by index when the model interleaves their fragments", async () => {
      // Real streams can interleave two tool calls: index 0 opens, index 1 opens, then
      // both continue in alternating deltas rather than finishing one before the next
      // starts. Bucketing must not concatenate one call's fragments onto the other's.
      mockFetch.mockResolvedValueOnce(
        sseRawChunksResponse(
          [
            { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "saveNote", arguments: "" } }] },
            { tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "askUser", arguments: "" } }] },
            { tool_calls: [{ index: 0, function: { arguments: "{\"text\":\"buy " } }] },
            { tool_calls: [{ index: 1, function: { arguments: "{\"question\":\"When" } }] },
            { tool_calls: [{ index: 0, function: { arguments: "milk\"}" } }] },
            { tool_calls: [{ index: 1, function: { arguments: " is it due?\"}" } }] },
          ],
          "tool_calls",
        ),
      );
      const adapter = createOpenAiCompatibleAdapter(config);
      const stream = await adapter.streamChat({
        model: "google/gemini-2.0-flash-001",
        messages: [{ role: "user", content: "note to buy milk, and ask when it's due" }],
        tools: [
          { name: "saveNote", description: "Saves a note.", schema: v.object({ text: v.string() }) },
          { name: "askUser", description: "Asks a clarifying question.", schema: v.object({ question: v.string() }) },
        ],
      });
      const parts = [];
      for await (const part of stream) parts.push(part);
      expect(parts).toEqual([
        { type: "toolCall", id: "call_1", name: "saveNote", arguments: { text: "buy milk" } },
        { type: "toolCall", id: "call_2", name: "askUser", arguments: { question: "When is it due?" } },
      ]);
    });

    it("hands back the raw string when the assembled arguments are not valid JSON", async () => {
      mockFetch.mockResolvedValueOnce(
        sseRawChunksResponse(
          [
            { tool_calls: [{ index: 0, id: "call_broken", type: "function", function: { name: "saveNote", arguments: "" } }] },
            { tool_calls: [{ index: 0, function: { arguments: "{not valid json" } }] },
          ],
          "tool_calls",
        ),
      );
      const adapter = createOpenAiCompatibleAdapter(config);
      const stream = await adapter.streamChat({
        model: "google/gemini-2.0-flash-001",
        messages: [{ role: "user", content: "note something" }],
        tools: [{ name: "saveNote", description: "Saves a note.", schema: v.object({ text: v.string() }) }],
      });
      const parts = [];
      for await (const part of stream) parts.push(part);
      expect(parts).toEqual([{ type: "toolCall", id: "call_broken", name: "saveNote", arguments: "{not valid json" }]);
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
