import { vi } from "vitest";
import type { AiAdapter, ChatMessage, ChatStreamPart, ModelInfo, StructuredResult, TestResult } from "../../modules/ai/ai.types.js";

// Anthropic's Messages API requires the conversation to alternate strictly between
// "user" and "assistant" turns and rejects two adjacent turns of the same role with a
// 400. System-role entries are pulled out and sent separately (see anthropic.adapter.ts),
// so they never take part in the adjacency check. This is a test-time guard, not
// production code: it exists so a usecase test that builds a same-role adjacency by
// mistake fails loudly here instead of only failing later, once, against a live
// provider. Shared here so the assistant's own turn-building tests guard the exact same
// invariant the AI layer's tests already do, rather than growing a second copy.
export function assertAlternatingRoles(messages: ChatMessage[]): void {
  const conversation = messages.filter((m) => m.role !== "system");
  for (let i = 1; i < conversation.length; i++) {
    const previous = conversation[i - 1]!;
    const current = conversation[i]!;
    if (previous.role === current.role) {
      throw new Error(
        `assertAlternatingRoles: two adjacent "${current.role}" turns at index ${i - 1} and ${i}. ` +
          `Anthropic requires user/assistant turns to alternate.`,
      );
    }
  }
}

// A fully stubbed AiAdapter with sane, overridable defaults, so a test only has to
// specify the one method it actually exercises. streamChat asserts role alternation on
// every call by default, since that is one invariant every caller through the AI layer
// must hold no matter which suite is exercising it.
export function fakeAdapter(overrides: Partial<AiAdapter> = {}): AiAdapter {
  return {
    generateStructured: vi.fn(async () => ({
      data: { items: [{ type: "tag", id: "t1", matched: true, confidence: 0.9, reasoning: "test" }] },
      usage: { promptTokens: 100, completionTokens: 20 },
    })),
    generateStructuredFromImages: vi.fn(async () => ({
      data: { items: [{ description: "test item", amount: 1 }] },
      usage: { promptTokens: 100, completionTokens: 20 },
    })),
    streamText: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield "hello";
      },
    })),
    streamChat: vi.fn(async (args: { messages: ChatMessage[] }) => {
      assertAlternatingRoles(args.messages);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "text" as const, text: "hello" };
        },
      };
    }),
    embed: vi.fn(async () => ({ vectors: [[0.1, 0.2]], dimension: 2 })),
    recognizeImage: vi.fn(async () => ({ text: "extracted text" })),
    transcribeAudio: vi.fn(async () => ({ text: "transcribed text" })),
    listModels: vi.fn(async () => [{ id: "test-model", label: "Test Model", contextLength: 8000 }] as ModelInfo[]),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 42, message: "Connected. 1 models available." }) as TestResult),
    ...overrides,
  };
}

// Wraps plain text chunks as the adapter's typed stream shape, for a caller that only
// needs the text half of ChatStreamPart.
export function chatStreamPartsOf(chunks: string[]): AsyncIterable<ChatStreamPart> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield { type: "text", text: chunk };
    },
  };
}
