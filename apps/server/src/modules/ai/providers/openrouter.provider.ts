import * as v from "valibot";
import { defineSetting } from "../../settings/settings.registry.js";
import type { AiProviderDefinition } from "../ai.types.js";

export const openrouterProvider: AiProviderDefinition = {
  id: "openrouter",
  label: "OpenRouter",
  adapter: "openai-compatible",
  defaultBaseUrl: "https://openrouter.ai/api/v1",
  requiresKey: true,
  capabilities: { text: true, structured: true, embeddings: true, listModels: true, vision: true, transcription: true, tools: true },
  suggestedModels: {
    rules: "google/gemini-3.8-flash",
    chat: "anthropic/claude-sonnet-5",
    // Embedding models are listed separately by OpenRouter's GET /api/v1/embeddings/models
    // endpoint, not the general models list. This id is verified against that catalog and
    // should be wired to the dedicated endpoint when embeddings are built.
    embedding: "openai/text-embedding-3-small",
    vision: "google/gemini-2.5-flash",
  },
  guide: {
    title: "Set up OpenRouter",
    intro: "OpenRouter gives you access to hundreds of models from many providers with a single API key. It is the recommended starting point for DocMind.",
    steps: [
      { text: "Go to the OpenRouter dashboard and create an account.", link: "https://openrouter.ai/settings/keys" },
      { text: "Click Create Key and copy it." },
      { text: "Paste the key below and click Test." },
    ],
    notes: [
      "OpenRouter charges per token. Check each model's pricing on the models page.",
      "For sorting rules, pick a model that supports structured output. The suggested model is a good default.",
    ],
  },
  settings: [
    defineSetting({
      key: "ai.openrouter.apiKey",
      schema: v.pipe(v.string(), v.minLength(1)),
      env: "OPENROUTER_API_KEY",
      secret: true,
      doc: "OpenRouter API key.",
    }),
    defineSetting({
      key: "ai.openrouter.baseUrl",
      schema: v.pipe(v.string(), v.url()),
      env: "OPENROUTER_BASE_URL",
      default: "https://openrouter.ai/api/v1",
      doc: "OpenRouter API base URL.",
    }),
  ],
};
