// Informed by the OpenAI SDK's chat.completions.create and models.list patterns.
import OpenAI from "openai";
import { toJsonSchema } from "@valibot/to-json-schema";
import { createError } from "../../../shared/errors/errors.js";
import { sanitizeProviderError } from "../ai.models.js";
import type { AiAdapter, ChatMessage, ModelInfo, StructuredResult, EmbedResult, TestResult } from "../ai.types.js";
import type { AdapterConfig } from "./adapter.types.js";
import type { ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

// ChatMessage carries a single role union across system, user, and assistant, while the
// SDK's ChatCompletionMessageParam is a discriminated union with a distinct interface per
// role. A plain cast would hide a real mismatch if the SDK ever adds required per-role
// fields, so map explicitly instead.
function toChatCompletionMessage(message: ChatMessage): ChatCompletionMessageParam {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "assistant":
      return { role: "assistant", content: message.content };
    case "user":
      return { role: "user", content: message.content };
  }
}

// The regex-based sanitizeProviderError only recognizes sk-, sk-or-, and sk-ant-
// prefixed keys. This adapter also backs Mistral, DeepSeek, LM Studio, and Custom,
// whose key formats may not match those prefixes, so redact the exact configured
// key first as a format-independent pass, then run the prefix-based sanitizer.
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
        wrapError(err, config.apiKey);
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
        wrapError(err, config.apiKey);
      }
    },

    async streamChat({ model, messages, maxTokens }): Promise<AsyncIterable<string>> {
      try {
        const stream = await client.chat.completions.create({
          model,
          messages: messages.map(toChatCompletionMessage),
          stream: true,
          max_tokens: maxTokens,
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
        wrapError(err, config.apiKey);
      }
    },

    async recognizeImage({ model, image, mimeType, prompt }): Promise<{ text: string }> {
      try {
        const base64Image = image.toString("base64");
        const response = await client.chat.completions.create({
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } },
              ],
            },
          ],
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
          throw createError({
            code: "ai.provider_error",
            message: "No content in vision completion response",
            status: 502,
          });
        }

        return { text: content };
      } catch (err) {
        if (err instanceof Error && "code" in err && typeof (err as { code: unknown }).code === "string" && (err as { code: string }).code.startsWith("ai.")) throw err;
        wrapError(err, config.apiKey);
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
        wrapError(err, config.apiKey);
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
              ? supportedParams.includes("structured_outputs")
              : undefined,
          });
        }
        return models;
      } catch (err) {
        wrapError(err, config.apiKey);
      }
    },

    async testConnection(): Promise<TestResult> {
      const start = Date.now();
      const useListModels = config.listModels ?? true;
      try {
        if (useListModels) {
          const models = await this.listModels();
          return {
            ok: true,
            latencyMs: Date.now() - start,
            message: `Connected. ${models.length} models available.`,
          };
        }

        // The provider does not expose a models list endpoint: verify the
        // connection and the API key with a minimal one-token completion instead.
        await client.chat.completions.create({
          model: "gpt-3.5-turbo",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        });
        return {
          ok: true,
          latencyMs: Date.now() - start,
          message: "Connected.",
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
