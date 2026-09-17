import { describe, expect, it } from "vitest";
import type { OcrEngine } from "../ocr.js";
import { createImageExtractor } from "./image.extractor.js";

describe("image extractor", () => {
  it("passes languages and data dir to the engine and normalizes the text", async () => {
    const calls: unknown[] = [];
    const engine: OcrEngine = { recognize: async (bytes, opts) => { calls.push({ len: bytes.length, ...opts }); return { text: "  Total: 42\n\n\n\nThanks  ", confidence: 85 }; }, terminate: async () => {} };
    const extractor = createImageExtractor(engine);
    const r = await extractor.extract({ bytes: new Uint8Array(3), mimeType: "image/png", filename: "receipt.png" }, { ocrLanguages: "eng", dataDir: "/tmp/data" });
    expect(calls).toEqual([{ len: 3, languages: "eng", dataDir: "/tmp/data" }]);
    expect(r.text).toBe("Total: 42\n\nThanks");
    expect(r.confidence).toBe(85);
    expect(r.note).toBeUndefined();
  });

  it("notes when nothing was recognized but still reports confidence", async () => {
    const engine: OcrEngine = { recognize: async () => ({ text: "   ", confidence: 12 }), terminate: async () => {} };
    const r = await createImageExtractor(engine).extract({ bytes: new Uint8Array(1), mimeType: "image/jpeg", filename: "blank.jpg" }, { ocrLanguages: "eng", dataDir: "/tmp/data" });
    expect(r.text).toBe("");
    expect(r.confidence).toBe(12);
    expect(r.note).toMatch(/No text recognized/);
  });
});
