import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "../database/database.js";
import { jobsTable } from "./jobs.tables.js";
import type { Job, JobStatus, NewJob } from "./jobs.types.js";

export function createJobsRepository({ db }: { db: Database }) {
  return {
    async insert(job: NewJob, tx: Database = db) {
      await tx.insert(jobsTable).values(job);
    },

    async claimNext({ types, now }: { types: string[]; now: string }): Promise<Job | null> {
      return db.transaction(async (tx) => {
        const [candidate] = await tx
          .select()
          .from(jobsTable)
          .where(and(eq(jobsTable.status, "pending"), inArray(jobsTable.type, types), lte(jobsTable.availableAt, now)))
          .orderBy(asc(jobsTable.createdAt), asc(jobsTable.id))
          .limit(1);
        if (!candidate) return null;
        const updated = await tx
          .update(jobsTable)
          .set({ status: "processing", startedAt: now, attempts: sql`${jobsTable.attempts} + 1` })
          .where(and(eq(jobsTable.id, candidate.id), eq(jobsTable.status, "pending")))
          .returning();
        return updated[0] ?? null;
      });
    },

    async markDone({ id, finishedAt }: { id: string; finishedAt: string }) {
      await db.update(jobsTable).set({ status: "done", finishedAt, error: null }).where(eq(jobsTable.id, id));
    },

    async markFailed({ id, error, finishedAt, retryAt }: { id: string; error: string; finishedAt: string; retryAt: string }) {
      await db.transaction(async (tx) => {
        const [row] = await tx.select().from(jobsTable).where(eq(jobsTable.id, id));
        if (!row) return;
        const exhausted = row.attempts >= row.maxAttempts;
        await tx
          .update(jobsTable)
          .set(exhausted ? { status: "failed", error, finishedAt } : { status: "pending", error, availableAt: retryAt, finishedAt: null })
          .where(eq(jobsTable.id, id));
      });
    },

    async resetProcessingToPending() {
      const rows = await db.update(jobsTable).set({ status: "pending", startedAt: null }).where(eq(jobsTable.status, "processing")).returning({ id: jobsTable.id });
      return rows.length;
    },

    async listForUser({ userId, status }: { userId: string; status?: JobStatus }) {
      const where = status ? and(eq(jobsTable.userId, userId), eq(jobsTable.status, status)) : eq(jobsTable.userId, userId);
      return db.select().from(jobsTable).where(where).orderBy(desc(jobsTable.createdAt), desc(jobsTable.id));
    },

    async findById({ userId, id }: { userId: string; id: string }) {
      const [row] = await db.select().from(jobsTable).where(and(eq(jobsTable.userId, userId), eq(jobsTable.id, id)));
      return row ?? null;
    },

    async countFailed(userId: string): Promise<number> {
      const [row] = await db.select({ count: sql<number>`count(*)` }).from(jobsTable).where(and(eq(jobsTable.userId, userId), eq(jobsTable.status, "failed")));
      return row?.count ?? 0;
    },

    async retry({ userId, id }: { userId: string; id: string }) {
      const now = new Date().toISOString();
      const rows = await db
        .update(jobsTable)
        .set({ status: "pending", attempts: 0, error: null, availableAt: now, startedAt: null, finishedAt: null })
        .where(and(eq(jobsTable.userId, userId), eq(jobsTable.id, id)))
        .returning();
      return rows[0] ?? null;
    },
  };
}

export type JobsRepository = ReturnType<typeof createJobsRepository>;
