import { describe, expect, it } from "vitest";
import { chunkText, estimateTokens, reciprocalRankFusion } from "./search.models.js";

describe("search models", () => {
  describe("chunkText", () => {
    it("produces zero chunks for empty text", () => {
      expect(chunkText("")).toEqual([]);
    });

    it("produces one chunk for text shorter than the limit", () => {
      const text = "Hello world.";
      const chunks = chunkText(text, 2000);
      expect(chunks).toEqual([{ text, startChar: 0, endChar: text.length }]);
    });

    it("splits at paragraph boundaries before hitting the character limit", () => {
      const paragraphA = "A".repeat(40);
      const paragraphB = "B".repeat(40);
      const text = `${paragraphA}\n\n${paragraphB}`;
      const chunks = chunkText(text, 50);

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ text: `${paragraphA}\n\n`, startChar: 0, endChar: 42 });
      expect(chunks[1]).toEqual({ text: paragraphB, startChar: 42, endChar: 82 });
    });

    it("splits at sentence boundaries when no paragraph break is available", () => {
      const text = "Aaa bbb ccc. Ddd eee fff. Ggg hhh iii.";
      const chunks = chunkText(text, 20);

      expect(chunks.map((c) => c.text)).toEqual(["Aaa bbb ccc. ", "Ddd eee fff. ", "Ggg hhh iii."]);
      // Offsets are contiguous and reference positions in the original text.
      expect(chunks[0]).toEqual({ text: "Aaa bbb ccc. ", startChar: 0, endChar: 13 });
      expect(chunks[1]).toEqual({ text: "Ddd eee fff. ", startChar: 13, endChar: 26 });
      expect(chunks[2]).toEqual({ text: "Ggg hhh iii.", startChar: 26, endChar: 38 });
    });

    it("hard-cuts at the character limit when no boundary is available", () => {
      const text = "x".repeat(45);
      const chunks = chunkText(text, 20);

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toEqual({ text: "x".repeat(20), startChar: 0, endChar: 20 });
      expect(chunks[1]).toEqual({ text: "x".repeat(20), startChar: 20, endChar: 40 });
      expect(chunks[2]).toEqual({ text: "x".repeat(5), startChar: 40, endChar: 45 });
    });

    it("covers the whole text with no gaps or overlaps across chunks", () => {
      const text = `${"A".repeat(30)}\n\n${"B".repeat(30)}\n\n${"C".repeat(30)}`;
      const chunks = chunkText(text, 35);
      const rebuilt = chunks.map((c) => c.text).join("");
      expect(rebuilt).toBe(text);
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].startChar).toBe(chunks[i - 1].endChar);
      }
    });
  });

  describe("estimateTokens", () => {
    it("estimates roughly one token per four characters", () => {
      expect(estimateTokens("")).toBe(0);
      expect(estimateTokens("abcd")).toBe(1);
      expect(estimateTokens("abcde")).toBe(2);
      expect(estimateTokens("a".repeat(100))).toBe(25);
    });
  });

  describe("reciprocalRankFusion", () => {
    it("merges two ranked lists, summing scores for shared documents", () => {
      const vector = ["doc_a", "doc_b"];
      const keyword = ["doc_b", "doc_a"];
      const fused = reciprocalRankFusion(vector, keyword, 60);

      // Both documents appear in both lists at complementary ranks, so they have the
      // same raw score and normalize to 1.0.
      expect(fused).toEqual([
        { documentId: "doc_a", score: 1 },
        { documentId: "doc_b", score: 1 },
      ]);
    });

    it("handles disjoint lists by keeping each document's single contribution", () => {
      const fused = reciprocalRankFusion(["doc_a"], ["doc_b"], 60);
      // Both have the same raw score (1/61), so both normalize to 1.0.
      expect(fused).toContainEqual({ documentId: "doc_a", score: 1 });
      expect(fused).toContainEqual({ documentId: "doc_b", score: 1 });
    });

    it("handles empty lists without error", () => {
      expect(reciprocalRankFusion([], [], 60)).toEqual([]);
      // Single item normalizes to 1.0.
      expect(reciprocalRankFusion(["doc_a"], [], 60)).toEqual([{ documentId: "doc_a", score: 1 }]);
      expect(reciprocalRankFusion([], ["doc_a"], 60)).toEqual([{ documentId: "doc_a", score: 1 }]);
    });

    it("sorts results by descending fused score", () => {
      const fused = reciprocalRankFusion(["doc_low", "doc_high"], ["doc_high"], 60);
      expect(fused.map((r) => r.documentId)).toEqual(["doc_high", "doc_low"]);
    });
  });
});
