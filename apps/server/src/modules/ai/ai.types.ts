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
  // Whether the adapter can send audio in a chat request and get a transcript back.
  // Telegram voice notes are the only caller today (telegram.usecases.ts), and they
  // resolve the vision slot rather than a slot of their own; see ai.usecases.ts
  // transcribeAudio for why.
  transcription: boolean;
  // Whether the adapter can build a tool-calling request and parse the provider's
  // wire format for it. A provider can declare this true and still refuse a specific
  // model at request time; ModelInfo.supportsTools is the finer, per-model signal.
  tools: boolean;
};

export type ModelSlot = "rules" | "chat" | "embedding" | "vision";

export type ModelInfo = {
  id: string;
  label: string;
  contextLength?: number;
  pricing?: { prompt: number; completion: number };
  supportsStructured?: boolean;
  // Per-model tool support, the same precedent as supportsStructured: only OpenRouter's
  // model list reports this today, so it stays undefined for every other provider rather
  // than guessed at.
  supportsTools?: boolean;
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

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// A tool the model may call. The schema doubles as the wire-level parameter shape,
// converted to JSON schema by the adapter, and the boundary the caller validates a
// tool call's arguments against once the adapter has assembled them.
export type ToolDefinition = {
  name: string;
  description: string;
  schema: GenericSchema;
};

// The typed shape a chat stream yields once tool calls are possible. Text arrives as
// it is produced; a tool call arrives once fully assembled, since a fragment of tool
// call JSON cannot be acted on before it is complete.
export type ChatStreamPart =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };

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
  // Multi-turn variant of streamText: takes a full messages array instead of a single
  // system and input string, for conversations that carry history (see the chat module).
  // Yields ChatStreamPart rather than plain strings so a tool call can travel alongside
  // text; passing no tools means the stream never contains a "toolCall" part.
  streamChat(args: {
    model: string;
    messages: ChatMessage[];
    maxTokens?: number;
    tools?: ToolDefinition[];
  }): Promise<AsyncIterable<ChatStreamPart>>;
  embed(args: { model: string; texts: string[] }): Promise<EmbedResult>;
  recognizeImage(args: {
    model: string;
    image: Buffer;
    mimeType: string;
    prompt: string;
  }): Promise<{ text: string }>;
  // Same shape as recognizeImage, for audio: a base64 payload, the container format it
  // was recorded in, and a prompt telling the model what to do with it.
  transcribeAudio(args: {
    model: string;
    audio: Buffer;
    format: string;
    prompt: string;
  }): Promise<{ text: string }>;
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
