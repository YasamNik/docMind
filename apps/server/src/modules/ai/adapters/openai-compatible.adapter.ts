// Informed by the OpenAI SDK's chat.completions.create and models.list patterns.
import OpenAI from "openai";
import { toJsonSchema } from "@valibot/to-json-schema";
import { createError } from "../../../shared/errors/errors.js";
import { sanitizeProviderError } from "../ai.models.js";
import type { AiAdapter, ModelInfo, StructuredResult, EmbedResult, TestResult } from "../ai.types.js";
import type { AdapterConfig } from "./adapter.types.js";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions.js";

function wrapError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  throw createError({
    code: "ai.provider_error",
    message: sanitizeProviderError(message),
    status: 502,
  });
}

export function createOpenAiCompatibleAdapter(config: AdapterConfig): AiAdapter {
  const headers: Record<string, string> = {};
  if (config.isOpenRouter) {
    headers["HTTP-Referer"] = "https://github.com/YasamNik/docMind";
    headers["X-Title"] = "DocMind";
  }

  const client = new OpenAI({
    apiKey: config.apiKey || "not-required",
    baseURL: config.baseUrl,
    defaultHeaders: Object.keys(headers).length > 0 ? headers : undefined,
  });

  return {
    async generateStructured({ model, system, input, schema, schemaName }): Promise<StructuredResult> {
      try {
        const jsonSchema = toJsonSchema(schema);
        // Remove the $schema key since OpenAI does not accept it
        const { $schema: _, ...cleanSchema } = jsonSchema as Record<string, unknown>;

        // Deviation from the brief: the installed openai SDK (7.16.0) builds the
        // request as `{ body, ...options }`, so passing `{ body: {...} }` as the
        // second `create()` argument replaces the whole request body instead of
        // merging into it. require_parameters is added to the body object itself.
        const body: ChatCompletionCreateParamsNonStreaming & { require_parameters?: boolean } = {
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: input },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: schemaName,
              strict: true,
              schema: cleanSchema as Record<string, unknown>,
            },
          },
          ...(config.isOpenRouter ? { require_parameters: true } : {}),
        };

        const response = await client.chat.completions.create(body);

        const content = response.choices[0]?.message?.content;
        if (!content) {
          throw createError({
            code: "ai.provider_error",
            message: "No content in completion response",
            status: 502,
          });
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
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
            promptTokens: response.usage?.prompt_tokens ?? 0,
            completionTokens: response.usage?.completion_tokens ?? 0,
          },
        };
      } catch (err) {
        if (err instanceof Error && "code" in err && typeof (err as { code: unknown }).code === "string" && (err as { code: string }).code.startsWith("ai.")) throw err;
        wrapError(err);
      }
    },

    async streamText({ model, system, input }): Promise<AsyncIterable<string>> {
      try {
        const stream = await client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: input },
          ],
          stream: true,
        });

        return {
          async *[Symbol.asyncIterator]() {
            for await (const chunk of stream) {
              const delta = chunk.choices[0]?.delta?.content;
              if (delta) yield delta;
            }
          },
        };
      } catch (err) {
        wrapError(err);
      }
    },

    async embed({ model, texts }): Promise<EmbedResult> {
      try {
        const response = await client.embeddings.create({
          model,
          input: texts,
        });

        const vectors = response.data.map((d) => d.embedding);
        const dimension = vectors[0]?.length ?? 0;

        return { vectors, dimension };
      } catch (err) {
        wrapError(err);
      }
    },

    async listModels(): Promise<ModelInfo[]> {
      try {
        const models: ModelInfo[] = [];
        for await (const model of client.models.list()) {
          const raw = model as unknown as Record<string, unknown>;
          const supportedParams = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];
          models.push({
            id: model.id,
            label: (raw.name as string) ?? model.id,
            contextLength: typeof raw.context_length === "number" ? raw.context_length : undefined,
            pricing:
              raw.pricing && typeof raw.pricing === "object"
                ? {
                    prompt: Number((raw.pricing as Record<string, string>).prompt ?? 0),
                    completion: Number((raw.pricing as Record<string, string>).completion ?? 0),
                  }
                : undefined,
            supportsStructured: config.isOpenRouter
              ? supportedParams.includes("structured_output")
              : undefined,
          });
        }
        return models;
      } catch (err) {
        wrapError(err);
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
          message: sanitizeProviderError(err instanceof Error ? err.message : String(err)),
        };
      }
    },
  };
}
