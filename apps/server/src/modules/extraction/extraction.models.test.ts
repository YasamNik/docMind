import { describe, expect, it } from "vitest";
import { extensionOf, normalizeText } from "./extraction.models.js";

describe("extensionOf", () => {
  it("returns the lowercased extension for a normal filename", () => {
    expect(extensionOf("report.pdf")).toBe(".pdf");
  });

  it("returns an empty string for a filename with no extension", () => {
    expect(extensionOf("README")).toBe("");
  });

  it("returns an empty string for a dotfile", () => {
    expect(extensionOf(".gitignore")).toBe("");
  });

  it("lowercases an uppercase extension", () => {
    expect(extensionOf("NOTES.MD")).toBe(".md");
  });

  it("returns a lone dot for a filename with a trailing dot", () => {
    expect(extensionOf("notes.")).toBe(".");
  });
});

describe("normalizeText", () => {
  it("collapses runs of more than two blank lines down to one blank line", () => {
    expect(normalizeText("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeText("  \n hello \n  ")).toBe("hello");
  });

  it("normalizes CRLF line endings to LF", () => {
    expect(normalizeText("a\r\nb\r\nc")).toBe("a\nb\nc");
  });
});
