import { normalizeText } from "../extraction.models.js";
import type { Extractor } from "../extraction.types.js";

export const textExtractor: Extractor = {
  id: "text",
  mimeTypes: ["text/plain", "text/markdown", "text/csv", "application/json"],
  async extract({ bytes }) {
    return { text: normalizeText(new TextDecoder("utf-8").decode(bytes)) };
  },
};
