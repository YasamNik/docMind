// Dispatch shape informed by papra's extractor lookup pattern: array find with an exact
// match then a wildcard family fallback.
import { EXTENSION_MIME, GENERIC_MIME, extensionOf } from "./extraction.models.js";
import type { Extractor } from "./extraction.types.js";

export function createExtractorRegistry(extractors: Extractor[]) {
  function byMime(mimeType: string): Extractor | null {
    const exact = extractors.find((e) => e.mimeTypes.includes(mimeType));
    if (exact) return exact;
    const family = `${mimeType.split("/")[0]}/*`;
    return extractors.find((e) => e.mimeTypes.includes(family)) ?? null;
  }

  return {
    find(mimeType: string, filename: string): Extractor | null {
      const normalized = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
      if (!GENERIC_MIME.has(normalized)) {
        const found = byMime(normalized);
        if (found) return found;
      }
      const guessed = EXTENSION_MIME[extensionOf(filename)];
      return guessed ? byMime(guessed) : null;
    },
    all() {
      return [...extractors];
    },
  };
}

export type ExtractorRegistry = ReturnType<typeof createExtractorRegistry>;
