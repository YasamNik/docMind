import type { jobsTable } from "./jobs.tables.js";

export type Job = typeof jobsTable.$inferSelect;
export type NewJob = typeof jobsTable.$inferInsert;
export type JobStatus = "pending" | "processing" | "done" | "failed";
