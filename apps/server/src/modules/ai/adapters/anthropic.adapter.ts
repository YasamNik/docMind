// Informed by the Anthropic SDK's messages.create and jsonSchemaOutputFormat patterns.
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { toJsonSchema } from "@valibot/to-json-schema";
import { createError } from "../../../shared/errors/errors.js";
import { sanitizeProviderError } from "../ai.models.js";
import type { AiAdapter, ChatMessage, ModelInfo, StructuredResult, EmbedResult, TestResult } from "../ai.types.js";
import type { AdapterConfig } from "./adapter.types.js";

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

    async streamChat({ model, messages, maxTokens }): Promise<AsyncIterable<string>> {
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
