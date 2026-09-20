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
  ChatStreamPart,
  EmbedResult,
  ImageInput,
  ModelInfo,
  ModelSlot,
  StructuredResult,
  TestResult,
  ToolDefinition,
} from "./ai.types.js";
import type { AdapterConfig } from "./adapters/adapter.types.js";

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_STRUCTURED_IMAGES = 10;

type CacheEntry = { models: ModelInfo[]; fetchedAt: number };
type AdapterFactories = {
  "openai-compatible": (config: AdapterConfig) => AiAdapter;
  "anthropic": (config: AdapterConfig) => AiAdapter;
};

// Drives one tool-calling turn against the adapter and validates any tool call the
// model makes against the schema the caller supplied for it. A call with arguments
// that fail validation is retried exactly once, with the parse error fed back to the
// model as an extra turn; a second failure is reported as ai.tool_call_invalid rather
// than guessed at or silently dropped.
//
// The retry appends two turns, not one: an assistant turn describing the failed call,
// then the user turn carrying the parse error. Anthropic's Messages API requires
// messages to alternate strictly between user and assistant roles and rejects two
// adjacent turns of the same role with a 400. The caller's messages already end in a
// user turn, so appending only a user correction would produce two user turns in a row.
// The assistant turn is not decoration: it stands in for the model's own failed call,
// which is what a real assistant turn there would have been. Once the adapters carry a
// real tool_use/tool_result wire shape, this pair becomes a faithful assistant tool_use
// content block plus a user turn holding a tool_result block with is_error set, instead
// of plain text standing in for both.
async function* driveToolCallStream({
  adapter,
  model,
  messages,
  toolMap,
  toolSpecs,
  maxTokens,
  attempt,
}: {
  adapter: AiAdapter;
  model: string;
  messages: ChatMessage[];
  toolMap: Map<string, ToolDefinition>;
  toolSpecs: ToolDefinition[];
  maxTokens?: number;
  attempt: number;
}): AsyncGenerator<ChatStreamPart> {
  const stream = await adapter.streamChat({ model, messages, maxTokens, tools: toolSpecs });
  for await (const part of stream) {
    if (part.type === "text") {
      yield part;
      continue;
    }

    const tool = toolMap.get(part.name);
    if (!tool) {
      throw createError({
        code: "ai.tool_call_invalid",
        message: `Model called unknown tool "${part.name}".`,
        status: 502,
      });
    }

    const parsed = v.safeParse(tool.schema, part.arguments);
    if (parsed.success) {
      yield { type: "toolCall", id: part.id, name: part.name, arguments: parsed.output };
      continue;
    }

    const firstIssue = parsed.issues[0];
    const issueMessage = firstIssue?.message ?? "arguments do not match the tool's schema";
    if (attempt >= 1) {
      throw createError({
        code: "ai.tool_call_invalid",
        message: `Model's call to "${part.name}" still had invalid arguments after a retry: ${issueMessage}`,
        status: 502,
      });
    }

    const retryMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: `I called "${part.name}" with arguments that did not match its schema.` },
      {
        role: "user",
        content: `Your call to "${part.name}" had invalid arguments: ${issueMessage}. Call the tool again with corrected arguments that match its schema.`,
      },
    ];
    yield* driveToolCallStream({ adapter, model, messages: retryMessages, toolMap, toolSpecs, maxTokens, attempt: attempt + 1 });
    return;
  }
}

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

  // Looks up a model's per-model info (currently only populated for OpenRouter) through
  // the same cache listModels() uses, so checking tool support on every chat turn does
  // not mean a network call on every chat turn. Returns undefined rather than throwing
  // when the list cannot be fetched, since that is a "cannot verify" case, not a "verified
  // unsupported" case.
  async function findModelInfo(
    provider: AiProviderDefinition,
    apiKey: string,
    baseUrl: string,
    model: string,
  ): Promise<ModelInfo | undefined> {
    const cacheKey = `${provider.id}:${baseUrl}`;
    const cached = modelCache.get(cacheKey);
    let models: ModelInfo[];
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      models = cached.models;
    } else {
      try {
        const adapter = buildAdapter(provider, apiKey, baseUrl);
        models = await adapter.listModels();
        modelCache.set(cacheKey, { models, fetchedAt: Date.now() });
      } catch {
        return undefined;
      }
    }
    return models.find((m) => m.id === model);
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

    // The multi-image counterpart to generateStructured: resolves the vision slot rather
    // than a task-named slot, since vision is the one slot that is actually multimodal.
    // Gated on both vision and structured because a model that reads images is not
    // guaranteed to also support JSON schema mode, and sending the request anyway would
    // fail with a confusing provider error instead of this module's own clear one.
    async generateStructuredFromImages<T>({
      userId,
      images,
      schema,
      schemaName,
      system,
    }: {
      userId: string;
      images: ImageInput[];
      schema: GenericSchema;
      schemaName: string;
      system: string;
    }): Promise<StructuredResult<T>> {
      if (images.length > MAX_STRUCTURED_IMAGES) {
        throw createError({
          code: "ai.too_many_images",
          message: `Too many images: got ${images.length}, maximum is ${MAX_STRUCTURED_IMAGES}.`,
          status: 400,
        });
      }

      const { model, provider, apiKey, baseUrl } = await resolveSlot(userId, "vision");
      if (!provider.capabilities.vision || !provider.capabilities.structured) {
        throw createError({
          code: "ai.capability_missing",
          message: `Provider "${provider.label}" does not support structured output from images.`,
          status: 400,
        });
      }
      const adapter = buildAdapter(provider, apiKey, baseUrl);
      const start = Date.now();
      const result = await adapter.generateStructuredFromImages({ model, system, images, schema, schemaName });
      const latencyMs = Date.now() - start;
      logger.info(
        { task: "vision", model: buildModelUri(provider.id, model), latencyMs, usage: result.usage, imageCount: images.length },
        "structured generation from images complete",
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
      web = false,
    }: {
      userId: string;
      messages: ChatMessage[];
      maxTokens?: number;
      // Attaches OpenRouter's live web search to this one request through the ":online"
      // model suffix, OpenRouter's documented equivalent of enabling its web plugin. Only
      // the Telegram /web command ever sets this; every other caller leaves it false, so
      // web search is never inferred and never carries over to the next request.
      web?: boolean;
    }): Promise<AsyncIterable<string>> {
      const { model, provider, apiKey, baseUrl } = await resolveSlot(userId, "chat");
      if (!provider.capabilities.text) {
        throw createError({
          code: "ai.capability_missing",
          message: `Provider "${provider.label}" does not support text generation.`,
          status: 400,
        });
      }
      if (web && provider.id !== "openrouter") {
        throw createError({
          code: "ai.web_search_unsupported",
          message: `Provider "${provider.label}" has no web search. /web only works with an OpenRouter chat model, so switch the chat slot in Settings to use it.`,
          status: 400,
        });
      }
      const adapter = buildAdapter(provider, apiKey, baseUrl);
      const start = Date.now();
      const requestModel = web ? `${model}:online` : model;
      const stream = await adapter.streamChat({ model: requestModel, messages, maxTokens });
      logger.info({ task: "chat", model: buildModelUri(provider.id, model), latencyMs: Date.now() - start, web }, "chat stream started");
      // No tools are ever passed here, so the adapter never yields a "toolCall" part;
      // this stays a plain text stream for the existing callers (chat and telegram
      // usecases), which predate tool calling and consume streamChat as strings.
      return {
        async *[Symbol.asyncIterator]() {
          for await (const part of stream) {
            if (part.type === "text") yield part.text;
          }
        },
      };
    },

    // Whether the configured chat slot can be offered tools at all: false when the
    // provider's adapter has no tool-calling wire support, or when OpenRouter's own
    // model list reports the specific model does not support them. Lets a caller ask
    // before offering tools instead of finding out from a failed call.
    async supportsTools(userId: string): Promise<boolean> {
      try {
        const { model, provider, apiKey, baseUrl } = await resolveSlot(userId, "chat");
        if (!provider.capabilities.tools) return false;
        if (provider.id === "openrouter") {
          const modelInfo = await findModelInfo(provider, apiKey, baseUrl, model);
          if (modelInfo?.supportsTools === false) return false;
        }
        return true;
      } catch {
        return false;
      }
    },

    // The tool-calling counterpart to streamChat: yields ChatStreamPart, including
    // validated tool calls, rather than plain text. Throws ai.tools_unsupported up
    // front rather than sending tools to a model that would silently ignore them.
    async streamChatWithTools({
      userId,
      messages,
      tools,
      maxTokens,
    }: {
      userId: string;
      messages: ChatMessage[];
      tools: ToolDefinition[];
      maxTokens?: number;
    }): Promise<AsyncIterable<ChatStreamPart>> {
      const { model, provider, apiKey, baseUrl } = await resolveSlot(userId, "chat");
      if (!provider.capabilities.text) {
        throw createError({
          code: "ai.capability_missing",
          message: `Provider "${provider.label}" does not support text generation.`,
          status: 400,
        });
      }
      if (!provider.capabilities.tools) {
        throw createError({
          code: "ai.tools_unsupported",
          message: `Provider "${provider.label}" does not support tool calling. Switch the chat slot in Settings to a model that does.`,
          status: 400,
        });
      }
      if (provider.id === "openrouter") {
        const modelInfo = await findModelInfo(provider, apiKey, baseUrl, model);
        if (modelInfo?.supportsTools === false) {
          throw createError({
            code: "ai.tools_unsupported",
            message: `Model "${model}" does not support tool calling on OpenRouter. Pick a different chat model to use the assistant's tools.`,
            status: 400,
          });
        }
      }
      const adapter = buildAdapter(provider, apiKey, baseUrl);
      const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
      logger.info({ task: "chat", model: buildModelUri(provider.id, model), tools: tools.map((t) => t.name) }, "tool chat stream started");
      return driveToolCallStream({ adapter, model, messages, toolMap, toolSpecs: tools, maxTokens, attempt: 0 });
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

    // Reuses the vision slot rather than a slot of its own: it is already the one
    // multimodal slot, set to gemini-2.5-flash, and Telegram voice notes are the only
    // caller today. Worth its own slot the day a user needs a different model for
    // audio than for images, not before.
    async transcribeAudio({
      userId,
      audio,
      format,
      prompt,
    }: {
      userId: string;
      audio: Buffer;
      format: string;
      prompt: string;
    }): Promise<{ text: string }> {
      const { model, provider, apiKey, baseUrl } = await resolveSlot(userId, "vision");
      if (!provider.capabilities.transcription) {
        throw createError({
          code: "ai.capability_missing",
          message: `Provider "${provider.label}" does not support audio transcription.`,
          status: 400,
        });
      }
      const adapter = buildAdapter(provider, apiKey, baseUrl);
      const start = Date.now();
      const result = await adapter.transcribeAudio({ model, audio, format, prompt });
      logger.info(
        { task: "vision", model: buildModelUri(provider.id, model), latencyMs: Date.now() - start },
        "audio transcription complete",
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

    async testSlot(userId: string, slot: string): Promise<TestResult> {
      try {
        const { providerId, model } = await resolveSlot(userId, slot as ModelSlot);
        const { provider, apiKey, baseUrl } = await getCredentials(userId, providerId);
        const adapter = buildAdapter(provider, apiKey, baseUrl);
        const start = Date.now();
        const result = await adapter.testConnection();
        logger.info({ slot, providerId, model, latencyMs: Date.now() - start }, "slot test complete");
        return { ...result, message: result.ok ? `${model}: ${result.latencyMs}ms` : result.message };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, latencyMs: 0, message };
      }
    },
  };
}

export type AiService = ReturnType<typeof createAiService>;
