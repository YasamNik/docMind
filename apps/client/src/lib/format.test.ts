import { describe, expect, it } from "vitest";
import { formatBytes, formatDocumentDate, formatReplacedAt } from "./format";

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

describe("formatReplacedAt", () => {
  it("shows the day, month and time an instructions version stopped being live", () => {
    // The exact hour depends on the machine's timezone, so this checks the shape
    // (day, short month, 24 hour time) rather than one fixed string.
    const result = formatReplacedAt("2026-09-19T14:02:00.000Z");
    expect(result).toMatch(/^\d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}$/);
  });
});
