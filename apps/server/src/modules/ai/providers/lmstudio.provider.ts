import * as v from "valibot";
import { defineSetting } from "../../settings/settings.registry.js";
import type { AiProviderDefinition } from "../ai.types.js";

export const lmstudioProvider: AiProviderDefinition = {
  id: "lmstudio",
  label: "LM Studio",
  adapter: "openai-compatible",
  defaultBaseUrl: "http://localhost:1234/v1",
  requiresKey: false,
  capabilities: { text: true, structured: true, embeddings: true, listModels: true, vision: true, tools: true },
  suggestedModels: {},
  guide: {
    title: "Set up LM Studio",
    intro: "Run models locally with LM Studio. Free, private, no API key needed.",
    steps: [
      { text: "Download and install LM Studio.", link: "https://lmstudio.ai" },
      { text: "Download a model inside LM Studio and start the local server (Developer tab, Start Server)." },
      { text: "The default port is 1234. Click Test below to verify the connection." },
    ],
    notes: [
      "LM Studio runs on your machine. The base URL defaults to localhost:1234.",
      "Make sure the server is running before testing.",
    ],
  },
  settings: [
    defineSetting({
      key: "ai.lmstudio.baseUrl",
      schema: v.pipe(v.string(), v.url()),
      env: "LMSTUDIO_BASE_URL",
      default: "http://localhost:1234/v1",
      doc: "LM Studio API base URL.",
    }),
  ],
};
