import type { Context, Hono } from "hono";
import { parseOrValidationError } from "../../shared/http/validate.js";
import { present } from "./jobs.models.js";
import { jobIdSchema, listJobsQuerySchema } from "./jobs.schemas.js";
import type { JobsService } from "./jobs.usecases.js";

export function registerJobsRoutes({ app, jobsService, getUserId }: { app: Hono; jobsService: JobsService; getUserId: (c: Context) => string }) {
  app.get("/api/jobs", async (c) => {
    const { status } = parseOrValidationError(listJobsQuerySchema, c.req.query());
    const jobs = await jobsService.list({ userId: getUserId(c), status });
    return c.json({ jobs: jobs.map(present) });
  });

  app.get("/api/jobs/counts", async (c) => {
    const failed = await jobsService.countFailed({ userId: getUserId(c) });
    return c.json({ failed });
  });

  app.post("/api/jobs/:id/retry", async (c) => {
    const id = parseOrValidationError(jobIdSchema, c.req.param("id"));
    const job = await jobsService.retry({ userId: getUserId(c), id });
    return c.json({ job: present(job) });
  });
}
