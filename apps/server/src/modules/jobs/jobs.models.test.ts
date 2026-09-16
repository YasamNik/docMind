import { describe, expect, it } from "vitest";
import { backoffMs, newJobId } from "./jobs.models.js";

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
});
