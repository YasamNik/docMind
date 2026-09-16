import { afterEach, describe, expect, it, vi } from "vitest";
import { jobsApi } from "./jobs-api";

afterEach(() => vi.restoreAllMocks());

describe("jobsApi", () => {
  it("lists with an optional status filter", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ jobs: [{ id: "job_1" }] }), { status: 200 }));
    expect(await jobsApi.list("failed")).toEqual([{ id: "job_1" }]);
    expect(spy.mock.calls[0]?.[0]).toBe("/api/jobs?status=failed");
    await jobsApi.list();
    expect(spy.mock.calls[1]?.[0]).toBe("/api/jobs");
  });

  it("retries by id", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ job: { id: "job_1", status: "pending" } }), { status: 200 }));
    expect(await jobsApi.retry("job_1")).toMatchObject({ status: "pending" });
    expect(spy.mock.calls[0]?.[0]).toBe("/api/jobs/job_1/retry");
    expect((spy.mock.calls[0]?.[1] as RequestInit).method).toBe("POST");
  });
});
