// Informed by the Anthropic SDK's messages.create and jsonSchemaOutputFormat patterns.
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { toJsonSchema } from "@valibot/to-json-schema";
import { createError } from "../../../shared/errors/errors.js";
import { sanitizeProviderError } from "../ai.models.js";
import type { AiAdapter, ModelInfo, StructuredResult, EmbedResult, TestResult } from "../ai.types.js";
import type { AdapterConfig } from "./adapter.types.js";

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
