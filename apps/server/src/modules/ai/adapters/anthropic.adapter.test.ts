import { describe, expect, it, vi, beforeEach } from "vitest";
import { createAnthropicAdapter } from "./anthropic.adapter.js";
import modelsFixture from "../__fixtures__/anthropic-models.json" with { type: "json" };
import structuredFixture from "../__fixtures__/anthropic-structured.json" with { type: "json" };
import visionFixture from "../__fixtures__/anthropic-vision.json" with { type: "json" };
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

// Anthropic's streaming wire format is named SSE events, each carrying a JSON payload
// that matches the event name. Builds the minimal valid sequence for a text reply made
// of the given deltas: message_start establishes the message, content_block_start opens
// the text block, one content_block_delta per delta, then the closing events.
function anthropicTextStream(deltas: string[]): Response {
  const events: Array<{ event: string; data: unknown }> = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-20250514",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 25, output_tokens: 0 },
        },
      },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    ...deltas.map((text) => ({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    })),
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: deltas.length } },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
  const body = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// Builds a raw named-SSE-event stream from the given event/data pairs, for tests that
// need control over the exact sequence of content_block_start, content_block_delta,
// and content_block_stop events a tool_use block produces.
function anthropicRawEventStream(events: Array<{ event: string; data: unknown }>): Response {
  const body = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// The SDK's client-side message accumulator requires a well-formed message_start as
// the first event of every stream, content array included, or it throws before any of
// our own parsing runs.
function messageStartEvent(): { event: string; data: unknown } {
  return {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-20250514",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
  };
}

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

  describe("streamChat", () => {
    it("extracts the system messages, sends the rest as the conversation, and yields the text deltas", async () => {
      mockFetch.mockResolvedValueOnce(anthropicTextStream(["Hello", " world"]));
      const adapter = createAnthropicAdapter(config);
      const stream = await adapter.streamChat({
        model: "claude-sonnet-4-20250514",
        messages: [
          { role: "system", content: "You are DocMind's chat assistant." },
          { role: "user", content: "What is the invoice total?" },
          { role: "assistant", content: "It is $128.50." },
          { role: "system", content: "Context from your documents:\n\n[1] From \"invoice.pdf\": ..." },
          { role: "user", content: "And the due date?" },
        ],
        maxTokens: 500,
      });
      const parts = [];
      for await (const part of stream) parts.push(part);
      expect(parts.every((p) => p.type === "text")).toBe(true);
      expect(parts.map((p) => (p.type === "text" ? p.text : "")).join("")).toBe("Hello world");

      const [callUrl, callInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callUrl).toBe("https://api.anthropic.com/v1/messages");
      const callBody = JSON.parse(callInit.body as string) as {
        model: string;
        max_tokens: number;
        system: string;
        messages: Array<{ role: string; content: string }>;
      };
      expect(callBody.model).toBe("claude-sonnet-4-20250514");
      expect(callBody.max_tokens).toBe(500);
      expect(callBody.system).toBe(
        "You are DocMind's chat assistant.\n\nContext from your documents:\n\n[1] From \"invoice.pdf\": ...",
      );
      expect(callBody.messages).toEqual([
        { role: "user", content: "What is the invoice total?" },
        { role: "assistant", content: "It is $128.50." },
        { role: "user", content: "And the due date?" },
      ]);
    });

    it("defaults max_tokens to 4096 when not given", async () => {
      mockFetch.mockResolvedValueOnce(anthropicTextStream(["Hi"]));
      const adapter = createAnthropicAdapter(config);
      const stream = await adapter.streamChat({
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "hi" }],
      });
      for await (const _chunk of stream) {
        // drain the stream
      }
      const [, callInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      const callBody = JSON.parse(callInit.body as string) as { max_tokens: number };
      expect(callBody.max_tokens).toBe(4096);
    });

    it("sends a tools array built from the schema and assembles a tool call from fragmented input_json_delta events", async () => {
      // Realistic wire shape: content_block_start opens the tool_use block with its id
      // and name (input starts as an empty placeholder), the input then arrives split
      // across three input_json_delta fragments, and content_block_stop closes it.
      const events = [
        messageStartEvent(),
        { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Sure, one moment. " } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
        {
          event: "content_block_start",
          data: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_abc123", name: "searchWeb", input: {} } },
        },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"query\":\"invoices " } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "over $100\"," } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"limit\":5}" } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
        { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } } },
        { event: "message_stop", data: { type: "message_stop" } },
      ];
      mockFetch.mockResolvedValueOnce(anthropicRawEventStream(events));
      const adapter = createAnthropicAdapter(config);
      const schema = v.object({ query: v.string(), limit: v.number() });
      const stream = await adapter.streamChat({
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "find invoices over $100" }],
        tools: [{ name: "searchWeb", description: "Searches the web.", schema }],
      });
      const parts = [];
      for await (const part of stream) parts.push(part);
      expect(parts).toEqual([
        { type: "text", text: "Sure, one moment. " },
        { type: "toolCall", id: "toolu_abc123", name: "searchWeb", arguments: { query: "invoices over $100", limit: 5 } },
      ]);

      const [, callInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      const callBody = JSON.parse(callInit.body as string) as { tools: Array<{ name: string; description: string; input_schema: { type: string } }> };
      expect(callBody.tools).toHaveLength(1);
      expect(callBody.tools[0]).toMatchObject({ name: "searchWeb", description: "Searches the web.", input_schema: { type: "object" } });
    });

    it("hands back the raw string when the assembled tool_use input is not valid JSON", async () => {
      const events = [
        messageStartEvent(),
        {
          event: "content_block_start",
          data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_broken", name: "saveNote", input: {} } },
        },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{not valid json" } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
        { event: "message_stop", data: { type: "message_stop" } },
      ];
      mockFetch.mockResolvedValueOnce(anthropicRawEventStream(events));
      const adapter = createAnthropicAdapter(config);
      const stream = await adapter.streamChat({
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "note something" }],
        tools: [{ name: "saveNote", description: "Saves a note.", schema: v.object({ text: v.string() }) }],
      });
      const parts = [];
      for await (const part of stream) parts.push(part);
      expect(parts).toEqual([{ type: "toolCall", id: "toolu_broken", name: "saveNote", arguments: "{not valid json" }]);
    });
  });

  describe("recognizeImage", () => {
    it("sends the image as a base64 content block and returns the extracted text", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(visionFixture), { status: 200, headers: { "content-type": "application/json" } }),
      );
      const adapter = createAnthropicAdapter(config);
      const image = Buffer.from("fake image bytes");
      const result = await adapter.recognizeImage({
        model: "claude-sonnet-4-20250514",
        image,
        mimeType: "image/png",
        prompt: "Extract all text from this document image.",
      });
      expect(result.text).toBe("Invoice #4471\nTotal Due: $128.50\nDate: 2026-01-15");

      const [callUrl, callInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callUrl).toBe("https://api.anthropic.com/v1/messages");
      const callBody = JSON.parse(callInit.body as string) as {
        model: string;
        max_tokens: number;
        messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
      };
      expect(callBody.model).toBe("claude-sonnet-4-20250514");
      expect(callBody.max_tokens).toBe(4096);
      const [message] = callBody.messages;
      expect(message?.role).toBe("user");
      expect(message?.content).toEqual([
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: image.toString("base64") },
        },
        { type: "text", text: "Extract all text from this document image." },
      ]);
    });
  });

  describe("embed", () => {
    it("throws ai.unsupported", async () => {
      const adapter = createAnthropicAdapter(config);
      await expect(adapter.embed({ model: "any", texts: ["hello"] })).rejects.toMatchObject({ code: "ai.unsupported" });
    });
  });

  describe("transcribeAudio", () => {
    it("throws ai.unsupported", async () => {
      const adapter = createAnthropicAdapter(config);
      await expect(
        adapter.transcribeAudio({ model: "any", audio: Buffer.from("x"), format: "ogg", prompt: "Transcribe this." }),
      ).rejects.toMatchObject({ code: "ai.unsupported" });
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
