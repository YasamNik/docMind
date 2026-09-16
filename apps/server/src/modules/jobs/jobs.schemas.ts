import * as v from "valibot";
import { jobStatusSchema } from "./jobs.models.js";

export const listJobsQuerySchema = v.object({ status: v.optional(jobStatusSchema) });
export const jobIdSchema = v.pipe(v.string(), v.regex(/^job_[0-9a-f]{16}$/));
