import * as v from "valibot";
import type { GenericSchema } from "valibot";
import type { Logger } from "../../shared/logger/logger.js";
import { createError } from "../../shared/errors/errors.js";
import { createLogger } from "../../shared/logger/logger.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import { parseModelUri, buildModelUri } from "./ai.models.js";
import type {
  AiAdapter,
  AiProviderDefinition,
  ChatMessage,
  EmbedResult,
  ModelInfo,
  ModelSlot,
  StructuredResult,
  TestResult,
} from "./ai.types.js";
import type { AdapterConfig } from "./adapters/adapter.types.js";

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

type CacheEntry = { models: ModelInfo[]; fetchedAt: number };
type AdapterFactories = {
  "openai-compatible": (config: AdapterConfig) => AiAdapter;
  "anthropic": (config: AdapterConfig) => AiAdapter;
};

export function createAiService({
  settingsService,
  registry,
  adapterFactories,
  logger = createLogger("ai"),
}: {
  settingsService: SettingsService;
  registry: Record<string, AiProviderDefinition>;
  adapterFactories: AdapterFactories;
  logger?: Logger;
}) {
  // Model list cache. Keyed by providerId and baseUrl since a base URL can be
  // user-specific (Ollama, LM Studio, Custom): including it in the key keeps one
  // user's results from being served to another user pointed at a different host.
  // The key omits userId because DocMind is single-user today; add it before any
  // multi-user work, or one user's cached list will leak to another.
  const modelCache = new Map<string, CacheEntry>();

  function getProvider(providerId: string): AiProviderDefinition {
    const provider = registry[providerId];
    if (!provider) {
      throw createError({
        code: "ai.unknown_provider",
        message: `Unknown AI provider "${providerId}"`,
        status: 400,
      });
    }
    return provider;
  }

  async function getCredentials(userId: string, providerId: string) {
    const provider = getProvider(providerId);
    // Only query settings that this provider actually registers. Ollama and LM Studio
    // have no apiKey setting; querying it would throw settings.unknown_key.
    const hasApiKey = provider.settings.some((s) => s.key === `ai.${providerId}.apiKey`);
    const hasBaseUrl = provider.settings.some((s) => s.key === `ai.${providerId}.baseUrl`);
    const apiKey = hasApiKey ? (await settingsService.get<string>(userId, `ai.${providerId}.apiKey`)) ?? "" : "";
    const baseUrl = hasBaseUrl
      ? (await settingsService.get<string>(userId, `ai.${providerId}.baseUrl`)) ?? provider.defaultBaseUrl
      : provider.defaultBaseUrl;
    return { provider, apiKey, baseUrl };
  }

  function buildAdapter(provider: AiProviderDefinition, apiKey: string, baseUrl: string): AiAdapter {
    const config: AdapterConfig = {
      apiKey,
      baseUrl,
      providerId: provider.id,
      isOpenRouter: provider.id === "openrouter",
      listModels: provider.capabilities.listModels,
    };
    return adapterFactories[provider.adapter](config);
  }

  async function resolveSlot(userId: string, task: ModelSlot) {
    const slotValue = await settingsService.get<string>(userId, `ai.model.${task}`);

    if (slotValue) {
      const { providerId, model } = parseModelUri(slotValue);
      const { provider, apiKey, baseUrl } = await getCredentials(userId, providerId);
      if (provider.requiresKey && !apiKey) {
        throw createError({
          code: "ai.provider_not_configured",
          message: `Provider "${provider.label}" requires an API key. Set it on the Settings page.`,
          status: 400,
        });
      }
      return { providerId, model, provider, apiKey, baseUrl };
    }

    // No slot set: use the first provider (registry order) that requires a key, has one
    // configured, and has a suggested model for this task. Keyless providers (Ollama, LM
    // Studio) are local network calls with no signal that the user actually set them up,
    // so they are never picked implicitly: a user must set the slot explicitly to use one.
    for (const providerId of Object.keys(registry)) {
      const provider = registry[providerId]!;
      if (!provider.requiresKey) continue;
      const suggested = provider.suggestedModels[task];
      if (!suggested) continue;

      const { apiKey, baseUrl } = await getCredentials(userId, providerId);
      if (!apiKey) continue;
      return { providerId, model: suggested, provider, apiKey, baseUrl };
    }

    throw createError({
      code: "ai.slot_not_configured",
      message: `No model configured for the "${task}" task. Set a provider key and pick a model on the Settings page.`,
      status: 400,
    });
  }

  return {
    resolveSlot,

    async generateStructured<T>({
      userId,
      task,
      schema,
      schemaName,
      system,
      input,
    }: {
      userId: string;
      task: ModelSlot;
      schema: GenericSchema;
      schemaName: string;
      system: string;
      input: string;
    }): Promise<StructuredResult<T>> {
      const { model, provider, apiKey, baseUrl } = await resolveSlot(userId, task);
      if (!provider.capabilities.structured) {
        throw createError({
          code: "ai.capability_missing",
          message: `Provider "${provider.label}" does not support structured output.`,
          status: 400,
        });
      }
      const adapter = buildAdapter(provider, apiKey, baseUrl);
      const start = Date.now();
      const result = await adapter.generateStructured({ model, system, input, schema, schemaName });
      const latencyMs = Date.now() - start;
      logger.info(
        { task, model: buildModelUri(provider.id, model), latencyMs, usage: result.usage },
        "structured generation complete",
      );

      const parsed = v.safeParse(schema, result.data);
      if (!parsed.success) {
        const firstIssue = parsed.issues[0];
        const path = firstIssue?.path?.map((p) => String(p.key)).join(".") ?? "";
        throw createError({
          code: "ai.invalid_response",
          message: `Model response does not match schema${path ? ` at ${path}` : ""}: ${firstIssue?.message ?? "invalid"}`,
          status: 502,
        });
      }

      return { data: parsed.output as T, usage: result.usage };
    },

    async streamText({
      userId,
      task,
      system,
      input,
    }: {
      userId: string;
      task: ModelSlot;
      system: string;
      input: string;
    }): Promise<AsyncIterable<string>> {
      const { model, provider, apiKey, baseUrl } = await resolveSlot(userId, task);
      if (!provider.capabilities.text) {
        throw createError({
          code: "ai.capability_missing",
          message: `Provider "${provider.label}" does not support text generation.`,
          status: 400,
        });
      }
      const adapter = buildAdapter(provider, apiKey, baseUrl);
      const start = Date.now();
      const stream = await adapter.streamText({ model, system, input });
      logger.info({ task, model: buildModelUri(provider.id, model), latencyMs: Date.now() - start }, "text stream started");
      return stream;
    },

    async streamChat({
      userId,
      messages,
      maxTokens,
    }: {
      userId: string;
      messages: ChatMessage[];
      maxTokens?: number;
    }): Promise<AsyncIterable<string>> {
      const { model, provider, apiKey, baseUrl } = await resolveSlot(userId, "chat");
      if (!provider.capabilities.text) {
        throw createError({
          code: "ai.capability_missing",
          message: `Provider "${provider.label}" does not support text generation.`,
          status: 400,
        });
      }
      const adapter = buildAdapter(provider, apiKey, baseUrl);
      const start = Date.now();
      const stream = await adapter.streamChat({ model, messages, maxTokens });
      logger.info({ task: "chat", model: buildModelUri(provider.id, model), latencyMs: Date.now() - start }, "chat stream started");
      return stream;
    },

    async embed({
      userId,
      task,
      texts,
    }: {
      userId: string;
      task: ModelSlot;
      texts: string[];
    }): Promise<EmbedResult> {
      const { model, provider, apiKey, baseUrl } = await resolveSlot(userId, task);
      if (!provider.capabilities.embeddings) {
        throw createError({
          code: "ai.capability_missing",
          message: `Provider "${provider.label}" does not support embeddings.`,
          status: 400,
        });
      }
      const adapter = buildAdapter(provider, apiKey, baseUrl);
      const start = Date.now();
      const result = await adapter.embed({ model, texts });
      logger.info(
        { task, model: buildModelUri(provider.id, model), latencyMs: Date.now() - start, count: texts.length },
        "embedding complete",
      );
      return result;
    },

    async recognizeImage({
      userId,
      image,
      mimeType,
      prompt,
    }: {
      userId: string;
      image: Buffer;
      mimeType: string;
      prompt: string;
    }): Promise<{ text: string }> {
      const { model, provider, apiKey, baseUrl } = await resolveSlot(userId, "vision");
      if (!provider.capabilities.vision) {
        throw createError({
          code: "ai.capability_missing",
          message: `Provider "${provider.label}" does not support vision.`,
          status: 400,
        });
      }
      const adapter = buildAdapter(provider, apiKey, baseUrl);
      const start = Date.now();
      const result = await adapter.recognizeImage({ model, image, mimeType, prompt });
      logger.info(
        { task: "vision", model: buildModelUri(provider.id, model), latencyMs: Date.now() - start },
        "image recognition complete",
      );
      return result;
    },

    async listModels(userId: string, providerId: string): Promise<{ models: ModelInfo[]; error?: string }> {
      const { provider, apiKey, baseUrl } = await getCredentials(userId, providerId);
      const cacheKey = `${providerId}:${baseUrl}`;
      const cached = modelCache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return { models: cached.models };
      }
      try {
        const adapter = buildAdapter(provider, apiKey, baseUrl);
        const models = await adapter.listModels();
        modelCache.set(cacheKey, { models, fetchedAt: Date.now() });
        return { models };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { models: [], error: message };
      }
    },

    async testConnection(userId: string, providerId: string): Promise<TestResult> {
      const { provider, apiKey, baseUrl } = await getCredentials(userId, providerId);
      const adapter = buildAdapter(provider, apiKey, baseUrl);
      const start = Date.now();
      const result = await adapter.testConnection();
      logger.info({ providerId, latencyMs: Date.now() - start }, "connection test complete");
      return result;
    },
  };
}

export type AiService = ReturnType<typeof createAiService>;
