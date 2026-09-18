import { describe, expect, it } from "vitest";
import { formatBytes, formatDocumentDate } from "./format";

describe("formatBytes", () => {
  it("formats sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("formatDocumentDate", () => {
  it("shows a dash when there is no document date", () => {
    expect(formatDocumentDate(null)).toBe("-");
  });

  it("formats a YYYY-MM-DD date without shifting a day for timezone", () => {
    expect(formatDocumentDate("2026-01-05")).toBe("Jan 5, 2026");
  });
});
