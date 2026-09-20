import * as v from "valibot";
import { defineSetting } from "../../settings/settings.registry.js";
import type { AiProviderDefinition } from "../ai.types.js";

export const deepseekProvider: AiProviderDefinition = {
  id: "deepseek",
  label: "DeepSeek",
  adapter: "openai-compatible",
  defaultBaseUrl: "https://api.deepseek.com/v1",
  requiresKey: true,
  capabilities: { text: true, structured: true, embeddings: false, listModels: true, vision: true, transcription: true, tools: true },
  suggestedModels: {
    rules: "deepseek-chat",
    chat: "deepseek-chat",
  },
  guide: {
    title: "Set up DeepSeek",
    intro: "Use DeepSeek models directly. Requires an API key from the DeepSeek platform.",
    steps: [
      { text: "Go to the DeepSeek platform.", link: "https://platform.deepseek.com/api_keys" },
      { text: "Create an API key and copy it." },
      { text: "Paste the key below and click Test." },
    ],
    notes: ["DeepSeek offers competitive pricing. Check their pricing page for current rates."],
  },
  settings: [
    defineSetting({
      key: "ai.deepseek.apiKey",
      schema: v.pipe(v.string(), v.minLength(1)),
      env: "DEEPSEEK_API_KEY",
      secret: true,
      doc: "DeepSeek API key.",
    }),
    defineSetting({
      key: "ai.deepseek.baseUrl",
      schema: v.pipe(v.string(), v.url()),
      env: "DEEPSEEK_BASE_URL",
      default: "https://api.deepseek.com/v1",
      doc: "DeepSeek API base URL.",
    }),
  ],
};
