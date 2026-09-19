import * as v from "valibot";
import { defineSetting } from "../../settings/settings.registry.js";
import type { AiProviderDefinition } from "../ai.types.js";

export const openaiProvider: AiProviderDefinition = {
  id: "openai",
  label: "OpenAI",
  adapter: "openai-compatible",
  defaultBaseUrl: "https://api.openai.com/v1",
  requiresKey: true,
  capabilities: { text: true, structured: true, embeddings: true, listModels: true, vision: true, tools: true },
  suggestedModels: {
    rules: "gpt-4o-mini",
    chat: "gpt-4o",
    embedding: "text-embedding-3-small",
    vision: "gpt-4o-mini",
  },
  guide: {
    title: "Set up OpenAI",
    intro: "Use OpenAI models directly. Requires an OpenAI API key with billing enabled.",
    steps: [
      { text: "Go to the OpenAI API keys page.", link: "https://platform.openai.com/api-keys" },
      { text: "Click Create new secret key and copy it." },
      { text: "Paste the key below and click Test." },
    ],
    notes: ["OpenAI charges per token. See their pricing page for current rates."],
  },
  settings: [
    defineSetting({
      key: "ai.openai.apiKey",
      schema: v.pipe(v.string(), v.minLength(1)),
      env: "OPENAI_API_KEY",
      secret: true,
      doc: "OpenAI API key.",
    }),
    defineSetting({
      key: "ai.openai.baseUrl",
      schema: v.pipe(v.string(), v.url()),
      env: "OPENAI_BASE_URL",
      default: "https://api.openai.com/v1",
      doc: "OpenAI API base URL.",
    }),
  ],
};
