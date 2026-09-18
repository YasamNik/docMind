import { createError } from "../../shared/errors/errors.js";
import type { Database } from "../database/database.js";
import { newJobId, nowIso } from "./jobs.models.js";
import { createJobsRepository } from "./jobs.repository.js";
import type { Job, JobStatus } from "./jobs.types.js";

export function createJobsService({ db }: { db: Database }) {
  const repository = createJobsRepository({ db });

  async function getOrThrow(userId: string, id: string): Promise<Job> {
    const job = await repository.findById({ userId, id });
    if (!job) throw createError({ code: "jobs.not_found", message: `Job "${id}" not found`, status: 404 });
    return job;
  }

  return {
    repository,

    async enqueue({ userId, type, payload, tx }: { userId: string; type: string; payload: unknown; tx?: Database }): Promise<Job> {
      const t = nowIso();
      const job: Job = {
        id: newJobId(),
        userId,
        type,
        status: "pending",
        payload: JSON.stringify(payload ?? {}),
        error: null,
        attempts: 0,
        maxAttempts: 3,
        availableAt: t,
        createdAt: t,
        startedAt: null,
        finishedAt: null,
      };
      await repository.insert(job, tx);
      return job;
    },

    list({ userId, status }: { userId: string; status?: JobStatus }) {
      return repository.listForUser({ userId, status });
    },

    get({ userId, id }: { userId: string; id: string }) {
      return getOrThrow(userId, id);
    },

    async countFailed({ userId }: { userId: string }) {
      return repository.countFailed(userId);
    },

    async retry({ userId, id }: { userId: string; id: string }) {
      const job = await getOrThrow(userId, id);
      if (job.status !== "failed") {
        throw createError({ code: "jobs.not_retryable", message: "Only failed jobs can be retried", status: 409 });
      }
      const row = await repository.retry({ userId, id });
      return row ?? job;
    },
  };
}

export type JobsService = ReturnType<typeof createJobsService>;
