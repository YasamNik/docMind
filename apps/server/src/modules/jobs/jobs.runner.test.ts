import { sql } from "drizzle-orm";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import { createJobsRepository } from "./jobs.repository.js";
import { createJobRunner } from "./jobs.runner.js";
import { createJobsService } from "./jobs.usecases.js";

const userId = "user-1";
const silentLogger = pino({ level: "silent" });

function sqlAvailableNow(id: string) {
  return sql`update jobs set available_at = '2000-01-01T00:00:00.000Z' where id = ${id}`;
}

async function setup() {
  const { db } = await createTestDatabase();
  const jobs = createJobsService({ db });
  const repo = createJobsRepository({ db });
  return { db, jobs, repo };
}

describe("job runner", () => {
  it("runs a registered handler and marks the job done", async () => {
    const { db, jobs, repo } = await setup();
    const seen: string[] = [];
    const runner = createJobRunner({ db, handlers: { echo: async (job) => { seen.push(JSON.parse(job.payload).value); } } });
    const job = await jobs.enqueue({ userId, type: "echo", payload: { value: "hi" } });
    expect(await runner.runOnce()).toBe(1);
    expect(seen).toEqual(["hi"]);
    expect(await repo.findById({ userId, id: job.id })).toMatchObject({ status: "done", attempts: 1 });
  });

  it("retries a failing handler with backoff and fails after three attempts", async () => {
    const { db, jobs, repo } = await setup();
    let calls = 0;
    const runner = createJobRunner({ db, handlers: { boom: async () => { calls += 1; throw new Error(`fail ${calls}`); } }, logger: silentLogger });
    const job = await jobs.enqueue({ userId, type: "boom", payload: {} });

    expect(await runner.runOnce()).toBe(1);
    let row = await repo.findById({ userId, id: job.id });
    expect(row).toMatchObject({ status: "pending", attempts: 1, error: "fail 1" });
    expect(new Date(row!.availableAt).getTime()).toBeGreaterThan(Date.now());

    // Not yet available, so nothing runs.
    expect(await runner.runOnce()).toBe(0);

    // Make it available and run twice more.
    await db.run(sqlAvailableNow(job.id));
    expect(await runner.runOnce()).toBe(1);
    await db.run(sqlAvailableNow(job.id));
    expect(await runner.runOnce()).toBe(1);
    row = await repo.findById({ userId, id: job.id });
    expect(row).toMatchObject({ status: "failed", attempts: 3, error: "fail 3" });
    expect(calls).toBe(3);
  });

  it("ignores job types with no handler", async () => {
    const { db, jobs, repo } = await setup();
    const runner = createJobRunner({ db, handlers: { echo: async () => {} } });
    const job = await jobs.enqueue({ userId, type: "unknown", payload: {} });
    expect(await runner.runOnce()).toBe(0);
    expect(await repo.findById({ userId, id: job.id })).toMatchObject({ status: "pending" });
  });

  it("recovers processing jobs on start and stops cleanly", async () => {
    const { db, jobs, repo } = await setup();
    const job = await jobs.enqueue({ userId, type: "echo", payload: {} });
    await repo.claimNext({ types: ["echo"], now: new Date().toISOString() });
    expect(await repo.findById({ userId, id: job.id })).toMatchObject({ status: "processing" });
    const runner = createJobRunner({ db, handlers: { echo: async () => {} }, pollIntervalMs: 10 });
    await runner.start();
    await new Promise((r) => setTimeout(r, 100));
    await runner.stop();
    expect(await repo.findById({ userId, id: job.id })).toMatchObject({ status: "done" });
  });

  it("processes a claimed batch of mixed outcomes sequentially on the single connection", async () => {
    const { db, jobs, repo } = await setup();
    const ok = await jobs.enqueue({ userId, type: "echo", payload: { n: 1 } });
    const bad = await jobs.enqueue({ userId, type: "boom", payload: { n: 2 } });
    const runner = createJobRunner({
      db,
      handlers: { echo: async () => {}, boom: async () => { throw new Error("nope"); } },
      logger: silentLogger,
    });
    expect(await runner.runOnce()).toBe(2);
    expect(await repo.findById({ userId, id: ok.id })).toMatchObject({ status: "done" });
    expect(await repo.findById({ userId, id: bad.id })).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("service retry only applies to failed jobs", async () => {
    const { db, jobs } = await setup();
    const runner = createJobRunner({ db, handlers: { boom: async () => { throw new Error("no"); } }, logger: silentLogger });
    const job = await jobs.enqueue({ userId, type: "boom", payload: {} });
    await expectAppError(() => jobs.retry({ userId, id: job.id }), "jobs.not_retryable");
    for (let i = 0; i < 3; i += 1) {
      await db.run(sqlAvailableNow(job.id));
      await runner.runOnce();
    }
    expect((await jobs.get({ userId, id: job.id })).status).toBe("failed");
    expect(await jobs.retry({ userId, id: job.id })).toMatchObject({ status: "pending", attempts: 0 });
    await expectAppError(() => jobs.get({ userId, id: "job_0000000000000000" }), "jobs.not_found");
  });
});
