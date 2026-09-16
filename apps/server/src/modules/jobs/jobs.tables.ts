import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const jobsTable = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    payload: text("payload").notNull(),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    availableAt: text("available_at").notNull(),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (t) => [index("jobs_claim_idx").on(t.status, t.type, t.availableAt, t.createdAt), index("jobs_user_idx").on(t.userId, t.createdAt)],
);
