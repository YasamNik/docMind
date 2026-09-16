import { normalizeText } from "../extraction.models.js";
import type { Extractor } from "../extraction.types.js";
import type { OcrEngine } from "../ocr.js";

export const NO_TEXT_IN_IMAGE_NOTE = "No text recognized in this image.";

export function createImageExtractor(engine: OcrEngine): Extractor {
  return {
    id: "image",
    mimeTypes: ["image/*"],
    async extract({ bytes }, ctx) {
      const raw = await engine.recognize(bytes, { languages: ctx.ocrLanguages, dataDir: ctx.dataDir });
      const text = normalizeText(raw);
      return text.length > 0 ? { text } : { text: "", note: NO_TEXT_IN_IMAGE_NOTE };
    },
  };
}
