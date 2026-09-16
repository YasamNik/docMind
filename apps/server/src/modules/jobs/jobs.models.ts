import { randomBytes } from "node:crypto";
import * as v from "valibot";
import type { Job } from "./jobs.types.js";

export const JOB_STATUSES = ["pending", "processing", "done", "failed"] as const;
export const jobStatusSchema = v.picklist(JOB_STATUSES);

export function present(job: Job) {
  let payload: unknown = {};
  try {
    payload = JSON.parse(job.payload);
  } catch {
    payload = {};
  }
  return { ...job, payload };
}

export function newJobId() {
  return `job_${randomBytes(8).toString("hex")}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function backoffMs(attempt: number) {
  return Math.min(2000 * 2 ** Math.max(0, attempt - 1), 60000);
}

export function isoAfter(fromIso: string, ms: number) {
  return new Date(new Date(fromIso).getTime() + ms).toISOString();
}
