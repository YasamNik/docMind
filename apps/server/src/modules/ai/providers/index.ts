import type { AiProviderDefinition } from "../ai.types.js";
import { openrouterProvider } from "./openrouter.provider.js";
import { openaiProvider } from "./openai.provider.js";
import { anthropicProvider } from "./anthropic.provider.js";
import { ollamaProvider } from "./ollama.provider.js";
import { mistralProvider } from "./mistral.provider.js";
import { deepseekProvider } from "./deepseek.provider.js";
import { lmstudioProvider } from "./lmstudio.provider.js";
import { customProvider } from "./custom.provider.js";

const ordered: AiProviderDefinition[] = [
  openrouterProvider,
  openaiProvider,
  anthropicProvider,
  ollamaProvider,
  mistralProvider,
  deepseekProvider,
  lmstudioProvider,
  customProvider,
];

export const aiProviderRegistry: Record<string, AiProviderDefinition> = {};
for (const def of ordered) {
  aiProviderRegistry[def.id] = def;
}

export const aiProviderIds = ordered.map((d) => d.id);
