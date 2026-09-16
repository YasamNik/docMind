import type { Database } from "../database/database.js";
import { createLogger, type Logger } from "../../shared/logger/logger.js";
import { backoffMs, isoAfter, nowIso } from "./jobs.models.js";
import { createJobsRepository } from "./jobs.repository.js";
import type { Job } from "./jobs.types.js";

export type JobHandler = (job: Job, ctx: { db: Database }) => Promise<void>;

/**
 * `concurrency` is the claim batch size per `runOnce()` call, not parallelism: the
 * libsql client is a single connection (true for both `:memory:` and file URLs), so
 * interleaving a transaction with any other statement on it is never safe. Claimed
 * jobs run one at a time on that single connection.
 */
export function createJobRunner({
  db,
  handlers,
  concurrency = 2,
  pollIntervalMs = 2000,
  logger = createLogger("jobs.runner"),
}: {
  db: Database;
  handlers: Record<string, JobHandler>;
  concurrency?: number;
  pollIntervalMs?: number;
  logger?: Logger;
}) {
  const repository = createJobsRepository({ db });
  const types = Object.keys(handlers);
  let running = false;
  let loop: Promise<void> | null = null;

  async function process(job: Job) {
    const handler = handlers[job.type];
    if (!handler) return;
    try {
      await handler(job, { db });
      await repository.markDone({ id: job.id, finishedAt: nowIso() });
    } catch (error) {
      const message = ((error as Error).message ?? String(error)).slice(0, 2000);
      const now = nowIso();
      await repository.markFailed({ id: job.id, error: message, finishedAt: now, retryAt: isoAfter(now, backoffMs(job.attempts)) });
      logger.warn({ jobId: job.id, type: job.type, attempt: job.attempts, err: message }, "Job failed");
    }
  }

  async function runOnce() {
    if (types.length === 0) return 0;
    const claimed: Job[] = [];
    for (let i = 0; i < concurrency; i += 1) {
      const job = await repository.claimNext({ types, now: nowIso() });
      if (!job) break;
      claimed.push(job);
    }
    for (const job of claimed) await process(job);
    return claimed.length;
  }

  async function start() {
    if (running) return;
    running = true;
    const recovered = await repository.resetProcessingToPending();
    if (recovered > 0) logger.info({ recovered }, "Reset stuck jobs to pending");
    loop = (async () => {
      while (running) {
        let ran = 0;
        try {
          ran = await runOnce();
        } catch (error) {
          logger.error({ err: error }, "Job runner iteration failed");
        }
        if (!running) break;
        if (ran === 0) await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
    })();
  }

  async function stop() {
    running = false;
    await loop;
    loop = null;
  }

  return { start, stop, runOnce };
}

export type JobRunner = ReturnType<typeof createJobRunner>;
