import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { normalizeText } from "../extraction.models.js";
import type { Extractor } from "../extraction.types.js";

export const NO_TEXT_LAYER_NOTE = "No text layer found. OCR for scanned PDFs is not available yet.";

export const pdfExtractor: Extractor = {
  id: "pdf",
  mimeTypes: ["application/pdf"],
  async extract({ bytes }) {
    // pdf.js v6 rejects Node Buffers; always hand it a plain Uint8Array copy.
    const data = new Uint8Array(bytes);
    const task = getDocument({ data, useSystemFonts: true, isEvalSupported: false, verbosity: 0 });
    try {
      const doc = await task.promise;
      const pages: string[] = [];
      for (let i = 1; i <= doc.numPages; i += 1) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const line = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ");
        pages.push(line);
      }
      const text = normalizeText(pages.join("\n\n"));
      return text.length > 0 ? { text } : { text: "", note: NO_TEXT_LAYER_NOTE };
    } finally {
      // destroy() lives on the loading task, not the resolved document, in pdfjs-dist v6.
      // Wrapping task.promise itself in this try/finally ensures the task is always released,
      // including when the promise rejects on a corrupted or malformed PDF.
      await task.destroy();
    }
  },
};
