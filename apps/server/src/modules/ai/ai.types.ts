import type { GenericSchema } from "valibot";
import type { SettingDefinition } from "../settings/settings.types.js";
import type { SetupGuide, SetupGuideStep } from "../storage/storage.types.js";

export type { SetupGuide, SetupGuideStep };

export type AiProviderCapabilities = {
  text: boolean;
  structured: boolean;
  embeddings: boolean;
  listModels: boolean;
  vision: boolean;
};

export type ModelSlot = "rules" | "chat" | "embedding" | "vision";

export type ModelInfo = {
  id: string;
  label: string;
  contextLength?: number;
  pricing?: { prompt: number; completion: number };
  supportsStructured?: boolean;
};

export type TestResult = {
  ok: boolean;
  latencyMs: number;
  message: string;
};

export type StructuredResult<T = unknown> = {
  data: T;
  usage: { promptTokens: number; completionTokens: number };
};

export type EmbedResult = {
  vectors: number[][];
  dimension: number;
};

export type AiAdapter = {
  generateStructured(args: {
    model: string;
    system: string;
    input: string;
    schema: GenericSchema;
    schemaName: string;
  }): Promise<StructuredResult>;
  streamText(args: {
    model: string;
    system: string;
    input: string;
  }): Promise<AsyncIterable<string>>;
  embed(args: { model: string; texts: string[] }): Promise<EmbedResult>;
  listModels(): Promise<ModelInfo[]>;
  testConnection(): Promise<TestResult>;
};

export type AiProviderDefinition = {
  id: string;
  label: string;
  adapter: "openai-compatible" | "anthropic";
  defaultBaseUrl: string;
  requiresKey: boolean;
  capabilities: AiProviderCapabilities;
  suggestedModels: { rules?: string; chat?: string; embedding?: string; vision?: string };
  guide: SetupGuide;
  settings: SettingDefinition[];
};
