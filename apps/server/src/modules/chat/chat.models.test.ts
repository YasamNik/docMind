import { describe, expect, it } from "vitest";
import {
  assembleChatContext,
  buildContextBlock,
  CHAT_SYSTEM_PROMPT,
  deriveTitleFromMessage,
  MAX_CONTEXT_CHARS,
  MAX_HISTORY_MESSAGES,
  newMessageId,
  newSessionId,
  parseCitations,
} from "./chat.models.js";
import type { Citation } from "./chat.types.js";

function citation(overrides: Partial<Citation> = {}): Citation {
  return {
    documentId: "doc_0000000000000001",
    documentName: "invoice.pdf",
    chunkText: "Rent due March 1st, $1200.",
    chunkIndex: 0,
    storageDriver: "local",
    ...overrides,
  };
}

describe("chat models", () => {
  describe("newSessionId", () => {
    it("returns sess_ followed by 16 hex characters", () => {
      const id = newSessionId();
      expect(id).toMatch(/^sess_[0-9a-f]{16}$/);
    });

    it("returns a different id on each call", () => {
      expect(newSessionId()).not.toBe(newSessionId());
    });
  });

  describe("newMessageId", () => {
    it("returns msg_ followed by 16 hex characters", () => {
      const id = newMessageId();
      expect(id).toMatch(/^msg_[0-9a-f]{16}$/);
    });

    it("returns a different id on each call", () => {
      expect(newMessageId()).not.toBe(newMessageId());
    });
  });

  describe("MAX constants", () => {
    it("caps context length at 12000 characters", () => {
      expect(MAX_CONTEXT_CHARS).toBe(12000);
    });

    it("caps history at 10 messages", () => {
      expect(MAX_HISTORY_MESSAGES).toBe(10);
    });
  });

  describe("deriveTitleFromMessage", () => {
    it("returns a short message unchanged", () => {
      expect(deriveTitleFromMessage("What is my rent?")).toBe("What is my rent?");
    });

    it("truncates a long message to the word boundary under the max length", () => {
      const long = "What are the exact renewal terms and penalty clauses described in the lease agreement document";
      const title = deriveTitleFromMessage(long, 60);
      expect(title.length).toBeLessThanOrEqual(60);
      expect(long.startsWith(title)).toBe(true);
      // Cutting at a word boundary means the title never ends mid-word from the source.
      expect(long[title.length]).toBe(" ");
    });

    it("respects a custom maxLength", () => {
      const title = deriveTitleFromMessage("short but not that short of a question", 10);
      expect(title.length).toBeLessThanOrEqual(10);
    });

    it("returns New chat for an empty message", () => {
      expect(deriveTitleFromMessage("")).toBe("New chat");
      expect(deriveTitleFromMessage("   ")).toBe("New chat");
    });
  });

  describe("assembleChatContext", () => {
    it("starts with the system prompt", () => {
      const messages = assembleChatContext({
        systemPrompt: CHAT_SYSTEM_PROMPT,
        chunks: [],
        history: [{ role: "user", content: "Hello" }],
      });
      expect(messages[0]).toEqual({ role: "system", content: CHAT_SYSTEM_PROMPT });
    });

    it("injects the retrieved chunks as a system message before the latest user message", () => {
      const chunks = [citation({ chunkText: "Rent is $1200 per month." })];
      const messages = assembleChatContext({
        systemPrompt: CHAT_SYSTEM_PROMPT,
        chunks,
        history: [{ role: "user", content: "How much is my rent?" }],
      });
      const last = messages.at(-1)!;
      const contextMessage = messages.at(-2)!;
      expect(last).toEqual({ role: "user", content: "How much is my rent?" });
      expect(contextMessage.role).toBe("system");
      expect(contextMessage.content).toContain("Rent is $1200 per month.");
      expect(contextMessage.content).toContain("[1]");
    });

    it("omits the context message when there are no chunks", () => {
      const messages = assembleChatContext({
        systemPrompt: CHAT_SYSTEM_PROMPT,
        chunks: [],
        history: [{ role: "user", content: "Hello" }],
      });
      expect(messages).toEqual([
        { role: "system", content: CHAT_SYSTEM_PROMPT },
        { role: "user", content: "Hello" },
      ]);
    });

    it("preserves interleaved user and assistant history in order", () => {
      const history = [
        { role: "user" as const, content: "Question one" },
        { role: "assistant" as const, content: "Answer one" },
        { role: "user" as const, content: "Question two" },
      ];
      const messages = assembleChatContext({ systemPrompt: CHAT_SYSTEM_PROMPT, chunks: [], history });
      expect(messages).toEqual([
        { role: "system", content: CHAT_SYSTEM_PROMPT },
        { role: "user", content: "Question one" },
        { role: "assistant", content: "Answer one" },
        { role: "user", content: "Question two" },
      ]);
    });

    it("keeps only the most recent MAX_HISTORY_MESSAGES entries", () => {
      const history = Array.from({ length: 14 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as const,
        content: `turn ${i}`,
      }));
      const messages = assembleChatContext({ systemPrompt: CHAT_SYSTEM_PROMPT, chunks: [], history });
      // system message plus the last MAX_HISTORY_MESSAGES history entries.
      expect(messages.length).toBe(1 + MAX_HISTORY_MESSAGES);
      expect(messages[1]).toEqual({ role: "user", content: "turn 4" });
      expect(messages.at(-1)).toEqual({ role: "assistant", content: "turn 13" });
    });

    it("respects MAX_CONTEXT_CHARS, dropping chunks that would exceed the cap", () => {
      const bigChunk = citation({ chunkText: "x".repeat(MAX_CONTEXT_CHARS) });
      const smallChunk = citation({ documentName: "other.pdf", chunkText: "short text" });
      const messages = assembleChatContext({
        systemPrompt: CHAT_SYSTEM_PROMPT,
        chunks: [bigChunk, smallChunk],
        history: [{ role: "user", content: "Question" }],
      });
      const contextMessage = messages.find((m) => m.content.includes("Context from your documents"))!;
      expect(contextMessage.content).toContain("x".repeat(100));
      expect(contextMessage.content).not.toContain("other.pdf");
    });
  });

  describe("buildContextBlock", () => {
    it("names the storage of a cited document that is not on the active storage", () => {
      const block = buildContextBlock([
        { documentId: "doc_1", documentName: "policy.pdf", chunkText: "cover", chunkIndex: 0, storageDriver: "googleDrive" },
      ]);
      expect(block).toContain("googleDrive");
    });
  });

  describe("parseCitations", () => {
    it("maps [1] and [2] references to the matching chunks in order", () => {
      const chunks = [
        citation({ documentId: "doc_a", chunkIndex: 0 }),
        citation({ documentId: "doc_b", chunkIndex: 1 }),
      ];
      const result = parseCitations("The rent is $1200 [1] and the lease ends in June [2].", chunks);
      expect(result).toEqual([chunks[0], chunks[1]]);
    });

    it("deduplicates repeated references", () => {
      const chunks = [citation({ documentId: "doc_a" })];
      const result = parseCitations("As stated [1], and again [1].", chunks);
      expect(result).toEqual([chunks[0]]);
    });

    it("ignores references with no matching chunk", () => {
      const chunks = [citation({ documentId: "doc_a" })];
      const result = parseCitations("See [1] and also [5].", chunks);
      expect(result).toEqual([chunks[0]]);
    });

    it("returns an empty array when the text has no citations", () => {
      const chunks = [citation()];
      expect(parseCitations("No references here.", chunks)).toEqual([]);
    });

    it("returns an empty array when there are no chunks", () => {
      expect(parseCitations("See [1].", [])).toEqual([]);
    });
  });
});
