import * as v from "valibot";
import { defineSetting } from "../../settings/settings.registry.js";
import type { AiProviderDefinition } from "../ai.types.js";

export const ollamaProvider: AiProviderDefinition = {
  id: "ollama",
  label: "Ollama",
  adapter: "openai-compatible",
  defaultBaseUrl: "http://localhost:11434/v1",
  requiresKey: false,
  capabilities: { text: true, structured: true, embeddings: true, listModels: true },
  suggestedModels: {
    rules: "llama3.1:8b",
    chat: "llama3.1:8b",
    embedding: "nomic-embed-text",
  },
  guide: {
    title: "Set up Ollama",
    intro: "Run models locally with Ollama. Free, private, no API key needed.",
    steps: [
      { text: "Install Ollama from the official site.", link: "https://ollama.ai" },
      { text: "Pull a model: ollama pull llama3.1:8b", copyValue: "ollama pull llama3.1:8b" },
      { text: "Make sure Ollama is running (it starts automatically after install), then click Test below." },
    ],
    notes: [
      "Ollama runs on your machine. The base URL defaults to localhost:11434.",
      "Structured output support varies by model. Newer models handle it better.",
    ],
  },
  settings: [
    defineSetting({
      key: "ai.ollama.baseUrl",
      schema: v.pipe(v.string(), v.url()),
      env: "OLLAMA_BASE_URL",
      default: "http://localhost:11434/v1",
      doc: "Ollama API base URL.",
    }),
  ],
};
