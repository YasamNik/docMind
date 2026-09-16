import { describe, expect, it } from "vitest";
import { createExtractorRegistry } from "./extraction.registry.js";
import type { Extractor } from "./extraction.types.js";

const stub = (id: string, mimeTypes: string[]): Extractor => ({ id, mimeTypes, extract: async () => ({ text: id }) });

describe("extractor registry", () => {
  const registry = createExtractorRegistry([
    stub("text", ["text/plain", "text/markdown"]),
    stub("pdf", ["application/pdf"]),
    stub("image", ["image/*"]),
  ]);

  it("matches exact MIME types", () => {
    expect(registry.find("application/pdf", "x.bin")?.id).toBe("pdf");
  });

  it("matches image wildcards", () => {
    expect(registry.find("image/png", "photo.png")?.id).toBe("image");
    expect(registry.find("image/heic", "photo.heic")?.id).toBe("image");
  });

  it("falls back to the extension for generic MIME types", () => {
    expect(registry.find("application/octet-stream", "notes.md")?.id).toBe("text");
    expect(registry.find("", "scan.pdf")?.id).toBe("pdf");
  });

  it("returns null when nothing matches", () => {
    expect(registry.find("application/zip", "archive.zip")).toBeNull();
  });

  it("does not fall back to the extension for a real, non-generic, unmatched MIME type", () => {
    expect(registry.find("application/foo", "notes.md")).toBeNull();
  });

  it("still falls back to the extension when the MIME type is generic", () => {
    expect(registry.find("application/octet-stream", "notes.md")?.id).toBe("text");
  });
});
