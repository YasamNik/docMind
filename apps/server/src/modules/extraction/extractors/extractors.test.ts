import { describe, expect, it } from "vitest";
import { docxWithParagraphs, pdfWithText, pdfWithoutText, pptxWithSlides, xlsxWithRows } from "../test-fixtures.js";
import type { ExtractorContext } from "../extraction.types.js";
import { docxExtractor } from "./docx.extractor.js";
import { pdfExtractor } from "./pdf.extractor.js";
import { pptxExtractor } from "./pptx.extractor.js";
import { textExtractor } from "./text.extractor.js";
import { xlsxExtractor } from "./xlsx.extractor.js";

const ctx: ExtractorContext = { ocrLanguages: "eng", dataDir: "/tmp/unused" };
const bytes = (s: string) => new TextEncoder().encode(s);

describe("extractors", () => {
  it("text decodes UTF-8 and normalizes blank lines", async () => {
    const r = await textExtractor.extract({ bytes: bytes("héllo\n\n\n\n\nworld\n"), mimeType: "text/plain", filename: "a.txt" }, ctx);
    expect(r.text).toBe("héllo\n\nworld");
  });

  it("pdf reads the text layer", async () => {
    const r = await pdfExtractor.extract({ bytes: pdfWithText("Hello DocMind"), mimeType: "application/pdf", filename: "a.pdf" }, ctx);
    expect(r.text).toContain("Hello DocMind");
    expect(r.note).toBeUndefined();
  });

  it("pdf without a text layer finishes with a note", async () => {
    const r = await pdfExtractor.extract({ bytes: pdfWithoutText(), mimeType: "application/pdf", filename: "scan.pdf" }, ctx);
    expect(r.text).toBe("");
    expect(r.note).toMatch(/OCR for scanned PDFs/);
  });

  it("docx reads paragraphs", async () => {
    const r = await docxExtractor.extract({ bytes: await docxWithParagraphs(["First paragraph", "Second paragraph"]), mimeType: docxExtractor.mimeTypes[0]!, filename: "a.docx" }, ctx);
    expect(r.text).toContain("First paragraph");
    expect(r.text).toContain("Second paragraph");
  });

  it("xlsx reads rows with a sheet heading", async () => {
    const r = await xlsxExtractor.extract({ bytes: await xlsxWithRows("Budget", [["Item", "Cost"], ["Rent", 1200]]), mimeType: xlsxExtractor.mimeTypes[0]!, filename: "a.xlsx" }, ctx);
    expect(r.text).toContain("# Budget");
    expect(r.text).toContain("Item\tCost");
    expect(r.text).toContain("Rent\t1200");
  });

  it("pptx reads slide text in order", async () => {
    const r = await pptxExtractor.extract({ bytes: await pptxWithSlides([["Title one"], ["Point a", "Point b"]]), mimeType: pptxExtractor.mimeTypes[0]!, filename: "a.pptx" }, ctx);
    expect(r.text.indexOf("Title one")).toBeLessThan(r.text.indexOf("Point a"));
    expect(r.text).toContain("# Slide 2");
    expect(r.text).toContain("Point b");
  });
});
