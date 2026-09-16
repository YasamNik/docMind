import * as v from "valibot";
import { defineSetting } from "../../settings/settings.registry.js";
import type { AiProviderDefinition } from "../ai.types.js";

export const customProvider: AiProviderDefinition = {
  id: "custom",
  label: "Custom (OpenAI-compatible)",
  adapter: "openai-compatible",
  defaultBaseUrl: "",
  requiresKey: true,
  capabilities: { text: true, structured: true, embeddings: true, listModels: true },
  suggestedModels: {},
  guide: {
    title: "Set up a custom provider",
    intro: "Connect any OpenAI-compatible API. Enter the base URL and API key for your provider.",
    steps: [
      { text: "Enter the base URL of your OpenAI-compatible API below (for example, https://my-provider.example.com/v1)." },
      { text: "Enter your API key if the provider requires one." },
      { text: "Click Test to verify the connection." },
    ],
    notes: [
      "The provider must support the OpenAI chat completions API format.",
      "A base URL is required for the custom provider.",
    ],
  },
  settings: [
    defineSetting({
      key: "ai.custom.apiKey",
      schema: v.pipe(v.string(), v.minLength(1)),
      env: "CUSTOM_API_KEY",
      secret: true,
      doc: "Custom provider API key.",
    }),
    defineSetting({
      key: "ai.custom.baseUrl",
      schema: v.pipe(v.string(), v.url()),
      env: "CUSTOM_BASE_URL",
      doc: "Custom provider API base URL. Required.",
    }),
  ],
};
