import { describe, expect, it } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";
import { createJobRunner } from "./jobs.runner.js";

describe("jobs routes", () => {
  it("lists jobs with parsed payloads, filters by status, and retries failed ones", async () => {
    const { app, db, services, signIn } = await createTestApp();
    const { cookie, userId } = await signIn();
    const jobs = services.jobsService;
    const ok = await jobs.enqueue({ userId, type: "echo", payload: { n: 1 } });
    const bad = await jobs.enqueue({ userId, type: "boom", payload: { n: 2 } });
    const runner = createJobRunner({ db, handlers: { echo: async () => {}, boom: async () => { throw new Error("nope"); } } });
    for (let i = 0; i < 3; i += 1) {
      await db.run((await import("drizzle-orm")).sql`update jobs set available_at = '2000-01-01T00:00:00.000Z'`);
      await runner.runOnce();
    }

    const all = await (await app.request("/api/jobs", { headers: { cookie } })).json();
    expect(all.jobs.map((j: { id: string }) => j.id).sort()).toEqual([ok.id, bad.id].sort());
    expect(all.jobs.find((j: { id: string }) => j.id === ok.id)).toMatchObject({ status: "done", payload: { n: 1 } });

    const failed = await (await app.request("/api/jobs?status=failed", { headers: { cookie } })).json();
    expect(failed.jobs.map((j: { id: string }) => j.id)).toEqual([bad.id]);
    expect(failed.jobs[0].error).toBe("nope");

    const retried = await app.request(`/api/jobs/${bad.id}/retry`, { method: "POST", headers: { cookie } });
    expect(retried.status).toBe(200);
    expect((await retried.json()).job).toMatchObject({ status: "pending", attempts: 0 });

    const again = await app.request(`/api/jobs/${ok.id}/retry`, { method: "POST", headers: { cookie } });
    expect(again.status).toBe(409);
    expect((await app.request("/api/jobs?status=bogus", { headers: { cookie } })).status).toBe(400);
    expect((await app.request("/api/jobs")).status).toBe(401);
  });
});
