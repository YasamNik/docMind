import mammoth from "mammoth";
import { normalizeText } from "../extraction.models.js";
import type { Extractor } from "../extraction.types.js";

export const docxExtractor: Extractor = {
  id: "docx",
  mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  async extract({ bytes }) {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return { text: normalizeText(result.value) };
  },
};
