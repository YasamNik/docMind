export type TextChunk = { text: string; startChar: number; endChar: number };

const DEFAULT_MAX_CHARS = 2000;
// A boundary candidate closer to the very start of the window would produce a chunk
// too small to be useful, so it is only accepted once it clears this fraction of maxChars.
const MIN_ACCEPTABLE_FRACTION = 0.3;

const SENTENCE_MARKERS = [". ", "! ", "? "];

function findCutPoint(remaining: string, maxChars: number): number {
  const window = remaining.slice(0, maxChars);
  const minAcceptable = Math.floor(maxChars * MIN_ACCEPTABLE_FRACTION);

  const paragraphIdx = window.lastIndexOf("\n\n");
  if (paragraphIdx >= minAcceptable) return paragraphIdx + 2;

  const lineIdx = window.lastIndexOf("\n");
  if (lineIdx >= minAcceptable) return lineIdx + 1;

  let bestSentenceCut = -1;
  for (const marker of SENTENCE_MARKERS) {
    const idx = window.lastIndexOf(marker);
    if (idx === -1) continue;
    const cut = idx + marker.length;
    if (idx >= minAcceptable && cut > bestSentenceCut) bestSentenceCut = cut;
  }
  if (bestSentenceCut !== -1) return bestSentenceCut;

  return maxChars;
}

// Character-based chunking with paragraph, then line, then sentence boundary awareness.
// Only falls back to a hard cut at maxChars when no boundary is found close enough to
// the end of the window to avoid producing a tiny chunk.
export function chunkText(text: string, maxChars = DEFAULT_MAX_CHARS): TextChunk[] {
  if (text.length === 0) return [];

  const chunks: TextChunk[] = [];
  let offset = 0;
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push({ text: remaining, startChar: offset, endChar: offset + remaining.length });
      break;
    }
    const cut = findCutPoint(remaining, maxChars);
    const piece = remaining.slice(0, cut);
    chunks.push({ text: piece, startChar: offset, endChar: offset + piece.length });
    offset += cut;
    remaining = remaining.slice(cut);
  }

  return chunks;
}

// Rough estimate, not a real tokenizer: about 4 characters per token for English text.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const DEFAULT_RRF_K = 60;

// Reciprocal rank fusion: merges two ranked id lists into one score per id, summing the
// contribution from each list the id appears in. Items in both lists rank higher than
// items in only one.
export function reciprocalRankFusion(
  vectorResults: string[],
  keywordResults: string[],
  k = DEFAULT_RRF_K,
): { documentId: string; score: number }[] {
  const scores = new Map<string, number>();

  const addList = (ids: string[]) => {
    ids.forEach((documentId, index) => {
      const rank = index + 1;
      const contribution = 1 / (k + rank);
      scores.set(documentId, (scores.get(documentId) ?? 0) + contribution);
    });
  };

  addList(vectorResults);
  addList(keywordResults);

  const results = Array.from(scores.entries())
    .map(([documentId, score]) => ({ documentId, score }))
    .sort((a, b) => b.score - a.score);

  if (results.length === 0) return results;
  const maxScore = results[0]!.score;
  return results.map((r) => ({ ...r, score: maxScore > 0 ? r.score / maxScore : 0 }));
}
