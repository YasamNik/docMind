import * as v from "valibot";
import { defineSetting } from "../../settings/settings.registry.js";
import type { AiProviderDefinition } from "../ai.types.js";

export const anthropicProvider: AiProviderDefinition = {
  id: "anthropic",
  label: "Anthropic",
  adapter: "anthropic",
  defaultBaseUrl: "https://api.anthropic.com",
  requiresKey: true,
  capabilities: { text: true, structured: true, embeddings: false, listModels: true, vision: true, transcription: false, tools: true },
  suggestedModels: {
    rules: "claude-haiku-3-5-20241022",
    chat: "claude-sonnet-4-20250514",
    vision: "claude-sonnet-4-20250514",
  },
  guide: {
    title: "Set up Anthropic",
    intro: "Use Claude models directly from Anthropic. Requires an API key from the Anthropic console.",
    steps: [
      { text: "Go to the Anthropic console API keys page.", link: "https://console.anthropic.com/settings/keys" },
      { text: "Click Create Key and copy it." },
      { text: "Paste the key below and click Test." },
    ],
    notes: [
      "Anthropic does not offer embedding models. Use OpenRouter or OpenAI for the embedding slot.",
    ],
  },
  settings: [
    defineSetting({
      key: "ai.anthropic.apiKey",
      schema: v.pipe(v.string(), v.minLength(1)),
      env: "ANTHROPIC_API_KEY",
      secret: true,
      doc: "Anthropic API key.",
    }),
    defineSetting({
      key: "ai.anthropic.baseUrl",
      schema: v.pipe(v.string(), v.url()),
      env: "ANTHROPIC_BASE_URL",
      default: "https://api.anthropic.com",
      doc: "Anthropic API base URL.",
    }),
  ],
};
