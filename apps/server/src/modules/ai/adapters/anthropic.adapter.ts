// Informed by the Anthropic SDK's messages.create and jsonSchemaOutputFormat patterns.
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { toJsonSchema } from "@valibot/to-json-schema";
import { createError } from "../../../shared/errors/errors.js";
import { sanitizeProviderError } from "../ai.models.js";
import type { AiAdapter, ChatMessage, ChatStreamPart, ModelInfo, StructuredResult, EmbedResult, TestResult, ToolDefinition } from "../ai.types.js";
import type { AdapterConfig } from "./adapter.types.js";
import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages.js";

const DEFAULT_MAX_TOKENS = 4096;

// The regex-based sanitizeProviderError only recognizes sk-, sk-or-, and sk-ant-
// prefixed keys. Redact the exact configured key first as a format-independent
// pass, then run the prefix-based sanitizer.
function sanitizeMessage(err: unknown, apiKey: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const withoutConfiguredKey = apiKey ? raw.split(apiKey).join("[redacted]") : raw;
  return sanitizeProviderError(withoutConfiguredKey);
}

function wrapError(err: unknown, apiKey: string): never {
  throw createError({
    code: "ai.provider_error",
    message: sanitizeMessage(err, apiKey),
    status: 502,
  });
}

function toAnthropicTool(tool: ToolDefinition): AnthropicTool {
  const jsonSchema = toJsonSchema(tool.schema);
  const { $schema: _, ...cleanSchema } = jsonSchema as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description,
    input_schema: cleanSchema as AnthropicTool["input_schema"],
  };
}

// A tool_use block's input arrives as a JSON string assembled from partial_json
// fragments across several content_block_delta events. Malformed JSON is handed back
// as the raw string rather than repaired, so the caller's schema validation fails on
// it with a clear message.
function parseToolArguments(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function createAnthropicAdapter(config: AdapterConfig): AiAdapter {
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || undefined,
  });

  return {
    async generateStructured({ model, system, input, schema, schemaName }): Promise<StructuredResult> {
      try {
        const jsonSchema = toJsonSchema(schema);
        const { $schema: _, ...cleanSchema } = jsonSchema as Record<string, unknown>;

        const response = await client.messages.create({
          model,
          max_tokens: 4096,
          system,
          messages: [{ role: "user", content: input }],
          output_config: {
            format: jsonSchemaOutputFormat({
              ...cleanSchema,
              type: "object" as const,
            } as Parameters<typeof jsonSchemaOutputFormat>[0]),
          },
        });

        const textBlock = response.content.find((b) => b.type === "text");
        if (!textBlock || textBlock.type !== "text") {
          throw createError({
            code: "ai.provider_error",
            message: "No text content in Anthropic response",
            status: 502,
          });
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(textBlock.text);
        } catch {
          throw createError({
            code: "ai.provider_error",
            message: "Response content is not valid JSON",
            status: 502,
          });
        }

        return {
          data: parsed,
          usage: {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
          },
        };
      } catch (err) {
        if (err instanceof Error && "code" in err && typeof (err as { code: unknown }).code === "string" && (err as { code: string }).code.startsWith("ai.")) throw err;
        wrapError(err, config.apiKey);
      }
    },

    async streamText({ model, system, input }): Promise<AsyncIterable<string>> {
      try {
        const stream = client.messages.stream({
          model,
          max_tokens: 4096,
          system,
          messages: [{ role: "user", content: input }],
        });

        return {
          async *[Symbol.asyncIterator]() {
            for await (const event of stream) {
              if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                yield event.delta.text;
              }
            }
          },
        };
      } catch (err) {
        wrapError(err, config.apiKey);
      }
    },

    async streamChat({ model, messages, maxTokens, tools }): Promise<AsyncIterable<ChatStreamPart>> {
      try {
        // Anthropic takes the system prompt as a separate top-level field, not as a
        // message with role "system". Pull every system-role entry out of the array
        // (assembleChatContext in the chat module can add more than one, for example
        // the base prompt plus a later context block) and join them, keeping the
        // conversational turns as the messages list.
        const systemParts = messages.filter((m: ChatMessage) => m.role === "system").map((m) => m.content);
        const conversation = messages.filter(
          (m): m is { role: "user" | "assistant"; content: string } => m.role !== "system",
        );

        const stream = client.messages.stream({
          model,
          max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
          messages: conversation,
          ...(tools && tools.length > 0 ? { tools: tools.map(toAnthropicTool) } : {}),
        });

        return {
          async *[Symbol.asyncIterator]() {
            // A tool_use content block opens with its id and name at content_block_start,
            // then its input arrives across one or more input_json_delta fragments keyed
            // by the block's index, and content_block_stop closes it. The fragments are
            // not valid JSON until the block closes, so they are concatenated per index
            // and only parsed, and only yielded, at that point.
            const toolCalls = new Map<number, { id: string; name: string; args: string }>();
            for await (const event of stream) {
              if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
                toolCalls.set(event.index, { id: event.content_block.id, name: event.content_block.name, args: "" });
                continue;
              }
              if (event.type === "content_block_delta") {
                if (event.delta.type === "text_delta") {
                  yield { type: "text", text: event.delta.text };
                } else if (event.delta.type === "input_json_delta") {
                  const call = toolCalls.get(event.index);
                  if (call) call.args += event.delta.partial_json;
                }
                continue;
              }
              if (event.type === "content_block_stop") {
                const call = toolCalls.get(event.index);
                if (call) {
                  toolCalls.delete(event.index);
                  yield { type: "toolCall", id: call.id, name: call.name, arguments: parseToolArguments(call.args) };
                }
              }
            }
          },
        };
      } catch (err) {
        wrapError(err, config.apiKey);
      }
    },

    async recognizeImage({ model, image, mimeType, prompt }): Promise<{ text: string }> {
      try {
        const base64Image = image.toString("base64");
        const response = await client.messages.create({
          model,
          max_tokens: 4096,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                    data: base64Image,
                  },
                },
                { type: "text", text: prompt },
              ],
            },
          ],
        });

        const textBlock = response.content.find((b) => b.type === "text");
        if (!textBlock || textBlock.type !== "text") {
          throw createError({
            code: "ai.provider_error",
            message: "No text content in Anthropic vision response",
            status: 502,
          });
        }

        return { text: textBlock.text };
      } catch (err) {
        if (err instanceof Error && "code" in err && typeof (err as { code: unknown }).code === "string" && (err as { code: string }).code.startsWith("ai.")) throw err;
        wrapError(err, config.apiKey);
      }
    },

    async embed(): Promise<EmbedResult> {
      throw createError({
        code: "ai.unsupported",
        message: "Anthropic does not support embeddings. Use OpenRouter or OpenAI for the embedding slot.",
        status: 400,
      });
    },

    async transcribeAudio(): Promise<{ text: string }> {
      throw createError({
        code: "ai.unsupported",
        message: "Anthropic does not support audio transcription. Use OpenRouter or OpenAI for the vision slot.",
        status: 400,
      });
    },

    async listModels(): Promise<ModelInfo[]> {
      try {
        const models: ModelInfo[] = [];
        for await (const model of client.models.list()) {
          models.push({
            id: model.id,
            label: model.display_name,
            contextLength: model.max_input_tokens ?? undefined,
          });
        }
        return models;
      } catch (err) {
        wrapError(err, config.apiKey);
      }
    },

    async testConnection(): Promise<TestResult> {
      const start = Date.now();
      try {
        const models = await this.listModels();
        return {
          ok: true,
          latencyMs: Date.now() - start,
          message: `Connected. ${models.length} models available.`,
        };
      } catch (err) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          message: sanitizeMessage(err, config.apiKey),
        };
      }
    },
  };
}
