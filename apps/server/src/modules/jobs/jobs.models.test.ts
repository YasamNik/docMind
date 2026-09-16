import { describe, expect, it } from "vitest";
import { backoffMs, isoAfter, newJobId, nowIso } from "./jobs.models.js";

describe("jobs models", () => {
  it("makes prefixed ids", () => {
    expect(newJobId()).toMatch(/^job_[0-9a-f]{16}$/);
  });

  it("backs off exponentially with a cap", () => {
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(2)).toBe(4000);
    expect(backoffMs(3)).toBe(8000);
    expect(backoffMs(10)).toBe(60000);
  });

  it("returns an ISO 8601 UTC timestamp", () => {
    const value = nowIso();
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(value).toISOString()).toBe(value);
  });

  it("adds milliseconds to a given ISO timestamp", () => {
    expect(isoAfter("2024-01-01T00:00:00.000Z", 0)).toBe("2024-01-01T00:00:00.000Z");
    expect(isoAfter("2024-01-01T00:00:00.000Z", 1500)).toBe("2024-01-01T00:00:01.500Z");
    expect(isoAfter("2024-01-01T00:00:00.000Z", 60000)).toBe("2024-01-01T00:01:00.000Z");
  });
});
