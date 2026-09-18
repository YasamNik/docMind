import { describe, expect, it } from "vitest";
import { DATE_FILTER_OPTIONS, dateFilterBadgeLabel, matchesDateFilter } from "./date-filter";

// Local time on purpose: the filter reasons about the user's own calendar days, so tests
// build values with the local Date constructor instead of literal UTC "Z" strings to stay
// correct regardless of the machine's timezone.
const NOW = new Date(2026, 5, 15, 12, 0, 0);

function localIso(year: number, month: number, day: number, hour = 0, minute = 0) {
  return new Date(year, month, day, hour, minute).toISOString();
}

describe("DATE_FILTER_OPTIONS", () => {
  it("lists the presets in display order with month to date and year to date between last 30 and last 90 days", () => {
    expect(DATE_FILTER_OPTIONS.map((o) => o.value)).toEqual(["all", "today", "7d", "30d", "mtd", "ytd", "90d", "custom"]);
  });
});

describe("matchesDateFilter", () => {
  it("matches everything for the all time preset", () => {
    expect(matchesDateFilter(null, { preset: "all" }, NOW)).toBe(true);
    expect(matchesDateFilter("2020-01-01T00:00:00.000Z", { preset: "all" }, NOW)).toBe(true);
  });

  it("matches only today's date for the today preset", () => {
    expect(matchesDateFilter(localIso(2026, 5, 15, 8), { preset: "today" }, NOW)).toBe(true);
    expect(matchesDateFilter(localIso(2026, 5, 14, 23, 59), { preset: "today" }, NOW)).toBe(false);
  });

  it("matches the last 7 days inclusive of today", () => {
    expect(matchesDateFilter(localIso(2026, 5, 9, 0), { preset: "7d" }, NOW)).toBe(true);
    expect(matchesDateFilter(localIso(2026, 5, 8, 23), { preset: "7d" }, NOW)).toBe(false);
  });

  it("matches the last 30 days", () => {
    expect(matchesDateFilter(localIso(2026, 4, 17, 0), { preset: "30d" }, NOW)).toBe(true);
    expect(matchesDateFilter(localIso(2026, 4, 15, 0), { preset: "30d" }, NOW)).toBe(false);
  });

  it("matches month to date from the 1st of the current month", () => {
    expect(matchesDateFilter(localIso(2026, 5, 1, 0), { preset: "mtd" }, NOW)).toBe(true);
    expect(matchesDateFilter(localIso(2026, 4, 31, 23), { preset: "mtd" }, NOW)).toBe(false);
  });

  it("matches year to date from January 1st of the current year", () => {
    expect(matchesDateFilter(localIso(2026, 0, 1, 0), { preset: "ytd" }, NOW)).toBe(true);
    expect(matchesDateFilter(localIso(2025, 11, 31, 23), { preset: "ytd" }, NOW)).toBe(false);
  });

  it("matches the last 90 days", () => {
    expect(matchesDateFilter(localIso(2026, 2, 18, 0), { preset: "90d" }, NOW)).toBe(true);
    expect(matchesDateFilter(localIso(2026, 2, 16, 0), { preset: "90d" }, NOW)).toBe(false);
  });

  it("matches a custom inclusive range", () => {
    const filter = { preset: "custom" as const, start: "2026-01-10", end: "2026-01-20" };
    expect(matchesDateFilter(localIso(2026, 0, 10, 0), filter, NOW)).toBe(true);
    expect(matchesDateFilter(localIso(2026, 0, 20, 23), filter, NOW)).toBe(true);
    expect(matchesDateFilter(localIso(2026, 0, 9, 23), filter, NOW)).toBe(false);
    expect(matchesDateFilter(localIso(2026, 0, 21, 0), filter, NOW)).toBe(false);
  });

  it("treats an open-ended custom range as bounded on only one side", () => {
    expect(matchesDateFilter(localIso(2026, 0, 1, 0), { preset: "custom", start: "2026-01-05" }, NOW)).toBe(false);
    expect(matchesDateFilter(localIso(2026, 0, 10, 0), { preset: "custom", start: "2026-01-05" }, NOW)).toBe(true);
  });

  it("excludes a null value for any preset except all time", () => {
    expect(matchesDateFilter(null, { preset: "today" }, NOW)).toBe(false);
    expect(matchesDateFilter(null, { preset: "custom", start: "2026-01-01" }, NOW)).toBe(false);
  });

  it("handles a date-only value such as an extracted document date without timezone drift", () => {
    expect(matchesDateFilter("2026-06-15", { preset: "today" }, NOW)).toBe(true);
    expect(matchesDateFilter("2026-06-14", { preset: "today" }, NOW)).toBe(false);
  });
});

describe("dateFilterBadgeLabel", () => {
  it("returns null for all time", () => {
    expect(dateFilterBadgeLabel({ preset: "all" })).toBeNull();
  });

  it("returns the preset label for a named preset", () => {
    expect(dateFilterBadgeLabel({ preset: "7d" })).toBe("Last 7 days");
  });

  it("returns null for an incomplete custom range", () => {
    expect(dateFilterBadgeLabel({ preset: "custom" })).toBeNull();
  });

  it("returns the range for a custom preset", () => {
    expect(dateFilterBadgeLabel({ preset: "custom", start: "2026-01-01", end: "2026-01-31" })).toBe("2026-01-01 to 2026-01-31");
  });
});
