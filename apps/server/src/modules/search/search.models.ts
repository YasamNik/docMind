import { randomBytes } from "node:crypto";

export function newSearchId() {
  return `srch_${randomBytes(8).toString("hex")}`;
}

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

// Words that carry no retrieval signal of their own. A question like "where is my driver
// licence?" is mostly these, and matching on them means a document has to repeat the
// question back to be found.
const QUERY_STOP_WORDS = new Set([
  "a", "about", "all", "am", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by", "can", "did", "do",
  "does", "find", "for", "from", "get", "give", "had", "has", "have", "how", "i", "if", "in", "into", "is", "it",
  "its", "me", "mine", "my", "of", "on", "or", "our", "out", "please", "show", "so", "some", "tell", "than", "that",
  "the", "their", "them", "then", "there", "these", "they", "this", "those", "to", "up", "us", "was", "we", "were",
  "what", "when", "where", "which", "who", "whose", "why", "with", "would", "you", "your",
]);

// Splits a query into the tokens worth matching on, with surrounding punctuation removed
// so "license?" and "license" behave the same. A single word query is taken literally,
// however common the word: someone searching for "will" means the document type.
export function meaningfulQueryTokens(query: string): string[] {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, ""))
    .filter((token) => token.length > 0);
  if (tokens.length <= 1) return tokens;
  return tokens.filter((token) => !QUERY_STOP_WORDS.has(token.toLowerCase()));
}

// How much further than the best match a chunk may sit and still be considered relevant.
// Absolute cosine distances are a property of the embedding model, not of relevance: on
// text-embedding-3-large a good match lands near 0.6 while unrelated text sits near 0.8,
// so the gap to the best row is the reliable signal and a fixed cutoff is not.
const DEFAULT_DISTANCE_MARGIN = 0.12;

export function withinDistanceMargin<T extends { distance: number }>(rows: T[], margin = DEFAULT_DISTANCE_MARGIN): T[] {
  if (rows.length === 0) return [];
  // Takes the minimum rather than the first row, so the result does not depend on the
  // caller having sorted the rows.
  const best = Math.min(...rows.map((row) => row.distance));
  return rows.filter((row) => row.distance <= best + margin);
}

// FTS5 bm25 rank is negative and more negative is a better match. A chunk that matched
// only a generic word can rank orders of magnitude weaker than the best row and still
// occupy a slot in the list, which reciprocal rank fusion would then score by position as
// though it were a real match. Keeping only the rows holding a meaningful share of the
// best row's strength stops a question about one bill from dragging in every other bill.
const DEFAULT_RANK_SHARE = 0.1;

export function withinRankShare<T extends { rank: number }>(rows: T[], share = DEFAULT_RANK_SHARE): T[] {
  if (rows.length === 0) return [];
  const best = Math.min(...rows.map((row) => row.rank));
  if (best >= 0) return rows;
  return rows.filter((row) => row.rank <= best * share);
}
