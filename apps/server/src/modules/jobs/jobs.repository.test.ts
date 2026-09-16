import { beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { newJobId, nowIso } from "./jobs.models.js";
import { createJobsRepository } from "./jobs.repository.js";
import type { NewJob } from "./jobs.types.js";

let repo: ReturnType<typeof createJobsRepository>;
const userId = "user-1";

function job(overrides: Partial<NewJob> = {}): NewJob {
  const t = nowIso();
  return {
    id: newJobId(),
    userId,
    type: "extraction",
    status: "pending",
    payload: JSON.stringify({ documentId: "doc_0000000000000001" }),
    error: null,
    attempts: 0,
    maxAttempts: 3,
    availableAt: t,
    createdAt: t,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

beforeEach(async () => {
  const { db } = await createTestDatabase();
  repo = createJobsRepository({ db });
});

describe("jobs repository", () => {
  it("claims the oldest available pending job and marks it processing", async () => {
    const older = job({ createdAt: "2026-01-01T00:00:00.000Z", availableAt: "2026-01-01T00:00:00.000Z" });
    const newer = job({ createdAt: "2026-01-02T00:00:00.000Z", availableAt: "2026-01-02T00:00:00.000Z" });
    await repo.insert(newer);
    await repo.insert(older);
    const claimed = await repo.claimNext({ types: ["extraction"], now: "2026-01-03T00:00:00.000Z" });
    expect(claimed?.id).toBe(older.id);
    expect(claimed).toMatchObject({ status: "processing", attempts: 1 });
    expect(claimed?.startedAt).not.toBeNull();
    const second = await repo.claimNext({ types: ["extraction"], now: "2026-01-03T00:00:00.000Z" });
    expect(second?.id).toBe(newer.id);
    expect(await repo.claimNext({ types: ["extraction"], now: "2026-01-03T00:00:00.000Z" })).toBeNull();
  });

  it("does not claim jobs that are not yet available or of another type", async () => {
    await repo.insert(job({ availableAt: "2999-01-01T00:00:00.000Z" }));
    await repo.insert(job({ type: "other" }));
    expect(await repo.claimNext({ types: ["extraction"], now: nowIso() })).toBeNull();
  });

  it("marks done and failed with retry semantics", async () => {
    const j = job();
    await repo.insert(j);
    const claimed = await repo.claimNext({ types: ["extraction"], now: nowIso() });
    await repo.markFailed({ id: claimed!.id, error: "boom", finishedAt: nowIso(), retryAt: "2026-01-01T00:00:00.000Z" });
    let row = await repo.findById({ userId, id: j.id });
    expect(row).toMatchObject({ status: "pending", attempts: 1, error: "boom", availableAt: "2026-01-01T00:00:00.000Z" });

    await repo.claimNext({ types: ["extraction"], now: nowIso() });
    await repo.markFailed({ id: j.id, error: "boom 2", finishedAt: nowIso(), retryAt: nowIso() });
    await repo.claimNext({ types: ["extraction"], now: nowIso() });
    await repo.markFailed({ id: j.id, error: "boom 3", finishedAt: nowIso(), retryAt: nowIso() });
    row = await repo.findById({ userId, id: j.id });
    expect(row).toMatchObject({ status: "failed", attempts: 3, error: "boom 3" });

    const retried = await repo.retry({ userId, id: j.id });
    expect(retried).toMatchObject({ status: "pending", attempts: 0, error: null });

    const again = await repo.claimNext({ types: ["extraction"], now: nowIso() });
    await repo.markDone({ id: again!.id, finishedAt: nowIso() });
    row = await repo.findById({ userId, id: j.id });
    expect(row).toMatchObject({ status: "done" });
    expect(row?.finishedAt).not.toBeNull();
  });

  it("resets processing jobs to pending on recovery", async () => {
    await repo.insert(job());
    await repo.insert(job());
    await repo.claimNext({ types: ["extraction"], now: nowIso() });
    expect(await repo.resetProcessingToPending()).toBe(1);
    const rows = await repo.listForUser({ userId });
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });

  it("lists newest first, filters by status, and scopes by user", async () => {
    await repo.insert(job({ createdAt: "2026-01-01T00:00:00.000Z" }));
    const late = job({ createdAt: "2026-01-02T00:00:00.000Z", status: "failed" });
    await repo.insert(late);
    await repo.insert(job({ userId: "someone-else" }));
    const all = await repo.listForUser({ userId });
    expect(all.map((r) => r.id)[0]).toBe(late.id);
    expect(all.length).toBe(2);
    expect((await repo.listForUser({ userId, status: "failed" })).map((r) => r.id)).toEqual([late.id]);
    expect(await repo.findById({ userId: "someone-else", id: late.id })).toBeNull();
    expect(await repo.retry({ userId: "someone-else", id: late.id })).toBeNull();
  });
});
