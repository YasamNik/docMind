import * as v from "valibot";
import { defineSetting } from "../../settings/settings.registry.js";
import type { AiProviderDefinition } from "../ai.types.js";

export const mistralProvider: AiProviderDefinition = {
  id: "mistral",
  label: "Mistral",
  adapter: "openai-compatible",
  defaultBaseUrl: "https://api.mistral.ai/v1",
  requiresKey: true,
  capabilities: { text: true, structured: true, embeddings: true, listModels: true, vision: true },
  suggestedModels: {
    rules: "mistral-small-latest",
    chat: "mistral-large-latest",
    embedding: "mistral-embed",
  },
  guide: {
    title: "Set up Mistral",
    intro: "Use Mistral AI models directly. Requires an API key from the Mistral console.",
    steps: [
      { text: "Go to the Mistral AI console.", link: "https://console.mistral.ai/api-keys" },
      { text: "Create an API key and copy it." },
      { text: "Paste the key below and click Test." },
    ],
    notes: ["Mistral charges per token. Check their pricing page for current rates."],
  },
  settings: [
    defineSetting({
      key: "ai.mistral.apiKey",
      schema: v.pipe(v.string(), v.minLength(1)),
      env: "MISTRAL_API_KEY",
      secret: true,
      doc: "Mistral AI API key.",
    }),
    defineSetting({
      key: "ai.mistral.baseUrl",
      schema: v.pipe(v.string(), v.url()),
      env: "MISTRAL_BASE_URL",
      default: "https://api.mistral.ai/v1",
      doc: "Mistral AI API base URL.",
    }),
  ],
};
