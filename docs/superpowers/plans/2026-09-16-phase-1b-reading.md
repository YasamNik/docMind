# Phase 1, Milestone B: Reading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every uploaded file becomes text through a visible, retryable job pipeline: a jobs table and runner, an extraction job with MIME dispatch, a Jobs page, and extracted text on the document page.

**Architecture:** Two new server modules. `jobs` owns the table, the repository, the runner loop, and the routes; handlers are registered by job type and know nothing about the loop. `extraction` owns an extractor registry keyed by MIME type and the handler that turns a document into text. Documents enqueue an extraction job on upload and expose a re-extract route. The client adds a Jobs page and an extracted-text panel, both polling while work is pending.

**Tech Stack:** Everything from Milestone A plus pdfjs-dist, tesseract.js, mammoth, exceljs, jszip.

**Spec:** `docs/superpowers/specs/2026-09-15-phase-1-smart-sorting-design.md` (Milestone B and its fixed decisions) and `DOCMIND-DESIGN.md` (Data Model: jobs table and status cache rules).

## Global Constraints

- Node 22 via nvm, pnpm via corepack. Before any pnpm command in a fresh shell: `source ~/.nvm/nvm.sh && nvm use 22 && corepack enable`.
- Every HTTP input and setting is parsed with valibot before use.
- All database access through Drizzle. Raw SQL only in migrations.
- The jobs table is the source of truth for background work. The status columns on documents are a cache updated in the same transaction as the job transition. Creating a job sets the document status to `pending` in the same transaction.
- On startup the runner resets every job still in `processing` to `pending`. A job that fails three times stays `failed` until retried by hand. Manual retry resets the attempt count.
- Timestamps are ISO 8601 strings in UTC.
- Extraction reads a document's bytes into memory because every parsing library needs a buffer; uploads remain streamed. Documents above 100 MB never reach extraction (the upload limit).
- Error codes are asserted in tests through `expectAppError(run, code)` from `apps/server/src/shared/test/errors.test-utils.ts`; messages stay clean.
- Module files are named by role. Tests sit next to the file as `*.test.ts`.
- No em dashes anywhere: code, comments, UI copy, commit messages.
- `ref_code/` is reference only. Read `ref_code/lecture/src/extractors.registry.ts` once for the dispatch shape if useful; never copy from it, never import it.
- Conventional commits, subject line first, blank line, then the harness's attribution trailers on their own lines.
- Run server tests with `pnpm --filter @docmind/server test`, client tests with `pnpm --filter @docmind/client test`.

## Interfaces inherited from Milestone A

- `apps/server/src/modules/database/database.ts`: `type Database`; `db.transaction(async (tx) => ...)` is available from Drizzle.
- `apps/server/src/modules/database/schema.ts`: re-exports every `*.tables.ts`.
- `apps/server/src/modules/documents/documents.usecases.ts`: `createDocumentsService({ db, storageService })` with `upload`, `list`, `get`, `rename`, `remove`, `openFile({ userId, documentId }) -> { document, stream }`. `documents.repository.ts` has `update({ userId, documentId, patch })`. `documents.types.ts` exports `Document`.
- `apps/server/src/modules/settings/settings.registry.ts`: `defineSetting`, `createSettingsRegistry`. `settings.definitions.ts`: `allSettingDefinitions` array. `settings.usecases.ts`: `SettingsService` with `get<T>(userId, key)`.
- `apps/server/src/server.ts`: `createServer({ config, db })` returns `{ app, auth, settingsService, storageService, documentsService, getUserId }`. Routes after `app.use("/api/*", sessionMiddleware(auth))` require a session.
- `apps/server/src/shared/http/validate.ts`: `parseJsonBody(c, schema)`, `parseOrValidationError(schema, value)`.
- `apps/server/src/shared/test/app.test-utils.ts`: `createTestApp(env?)` returning `{ app, db, services, config, signIn }`. `database.test-utils.ts`: `createTestDatabase()`.
- `apps/server/src/shared/logger/logger.ts`: `createLogger(namespace)`.
- Client: `src/lib/api.ts` (`api.get`, `api.json`, `api.del`, `ApiError`), `src/lib/documents-api.ts` (`documentsApi`, `DocumentRow`), `src/lib/format.ts`, shadcn components under `src/components/ui/`, pages under `src/pages/`, `App.tsx` with a `/jobs` placeholder route.

---

### Task 1: Jobs table, models, and repository

**Files:**
- Create: `apps/server/src/modules/jobs/jobs.tables.ts`, `jobs.types.ts`, `jobs.models.ts`, `jobs.repository.ts`
- Modify: `apps/server/src/modules/database/schema.ts`
- Test: `apps/server/src/modules/jobs/jobs.models.test.ts`, `apps/server/src/modules/jobs/jobs.repository.test.ts`

**Interfaces:**
- Table `jobs`: `id, user_id, type, status (pending|processing|done|failed), payload (JSON text), error, attempts, max_attempts (default 3), available_at, created_at, started_at, finished_at`.
- `jobs.models.ts`: `newJobId()` returning `job_` plus 16 hex chars; `backoffMs(attempt)` returning `2000 * 2 ** (attempt - 1)` capped at 60000; `nowIso()`; `JOB_STATUSES` tuple and `jobStatusSchema` (valibot picklist).
- `jobs.repository.ts`: `createJobsRepository({ db })` with
  - `insert(job: NewJob, tx?)`
  - `claimNext({ types, now }): Promise<Job | null>` atomically picks the oldest `pending` job with `available_at <= now` whose type is in `types`, marks it `processing`, sets `started_at`, increments `attempts`, and returns it. Implemented as a transaction: select then update where status is still pending; returns null if the row moved.
  - `markDone({ id, finishedAt })`
  - `markFailed({ id, error, finishedAt, retryAt })` sets status `failed` when `attempts >= max_attempts`, otherwise `pending` with `available_at = retryAt`
  - `resetProcessingToPending()` for startup recovery, returns the count
  - `listForUser({ userId, status? })` newest first
  - `findById({ userId, id })`
  - `retry({ userId, id })` sets `pending`, `attempts = 0`, `error = null`, `available_at = now`; returns the row or null
- `jobs.types.ts`: `Job`, `NewJob`, `JobStatus`.

- [ ] **Step 1: Write the failing model test**

`apps/server/src/modules/jobs/jobs.models.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { backoffMs, newJobId } from "./jobs.models.js";

describe("jobs models", () => {
  it("makes prefixed ids", () => {
    expect(newJobId()).toMatch(/^job_[0-9a-f]{16}$/);
  });

  it("backs off exponentially with a cap", () => {
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(2)).toBe(4000);
    expect(backoffMs(3)).toBe(8000);
    expect(backoffMs(10)).toBe(60000);
  });
});
```

- [ ] **Step 2: Write the failing repository test**

`apps/server/src/modules/jobs/jobs.repository.test.ts`:
```ts
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
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `pnpm --filter @docmind/server test -- jobs`
Expected: FAIL, cannot find module.

- [ ] **Step 4: Write the table, types, models, and repository**

`apps/server/src/modules/jobs/jobs.tables.ts`:
```ts
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
```

Add to `apps/server/src/modules/database/schema.ts`:
```ts
export * from "../jobs/jobs.tables.js";
```

`apps/server/src/modules/jobs/jobs.types.ts`:
```ts
import type { jobsTable } from "./jobs.tables.js";

export type Job = typeof jobsTable.$inferSelect;
export type NewJob = typeof jobsTable.$inferInsert;
export type JobStatus = "pending" | "processing" | "done" | "failed";
```

`apps/server/src/modules/jobs/jobs.models.ts`:
```ts
import { randomBytes } from "node:crypto";
import * as v from "valibot";

export const JOB_STATUSES = ["pending", "processing", "done", "failed"] as const;
export const jobStatusSchema = v.picklist(JOB_STATUSES);

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
```

`apps/server/src/modules/jobs/jobs.repository.ts`:
```ts
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
```

- [ ] **Step 5: Generate the migration and run the tests**

```bash
cd apps/server && pnpm db:generate --name jobs && cd ../..
pnpm --filter @docmind/server test -- jobs
```
Expected: PASS, 2 model tests and 5 repository tests. The generated migration is `0003_jobs.sql`.

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat(jobs): add jobs table, models, and repository with claim and retry semantics"
```

---

### Task 2: Job runner with handler registry and startup recovery

**Files:**
- Create: `apps/server/src/modules/jobs/jobs.runner.ts`, `apps/server/src/modules/jobs/jobs.usecases.ts`
- Test: `apps/server/src/modules/jobs/jobs.runner.test.ts`

**Interfaces:**
- `jobs.usecases.ts`: `createJobsService({ db })` with
  - `enqueue({ userId, type, payload, tx? }): Promise<Job>` inserting a pending job available now. `payload` is an object; it is JSON-stringified. Accepts an optional transaction so callers can update their own rows in the same transaction.
  - `list({ userId, status? })`, `get({ userId, id })` (404 `jobs.not_found`), `retry({ userId, id })` (404 when missing, 409 `jobs.not_retryable` unless status is `failed`).
- `jobs.runner.ts`: `createJobRunner({ db, handlers, concurrency = 2, pollIntervalMs = 2000, logger? })` with `start()`, `stop()`, and `runOnce(): Promise<number>` (claims and processes up to `concurrency` jobs once, returns how many ran; used by tests and by `start()`'s loop).
  - `handlers` is `Record<string, JobHandler>` where `JobHandler = (job: Job, ctx: { db: Database }) => Promise<void>`. Unknown types are never claimed because `claimNext` filters by the registered types.
  - A handler that throws marks the job failed through the repository with `retryAt = isoAfter(now, backoffMs(job.attempts))`. The error message is the thrown error's message, truncated to 2000 chars.
  - `start()` first calls `resetProcessingToPending()` and logs the count, then loops: `runOnce`, then wait `pollIntervalMs` if nothing ran, else loop immediately. `stop()` ends the loop after the current batch.

- [ ] **Step 1: Write the failing test**

`apps/server/src/modules/jobs/jobs.runner.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { createJobsRepository } from "./jobs.repository.js";
import { createJobRunner } from "./jobs.runner.js";
import { createJobsService } from "./jobs.usecases.js";

const userId = "user-1";

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
    const runner = createJobRunner({ db, handlers: { boom: async () => { calls += 1; throw new Error(`fail ${calls}`); } } });
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

  it("service retry only applies to failed jobs", async () => {
    const { db, jobs } = await setup();
    const runner = createJobRunner({ db, handlers: { boom: async () => { throw new Error("no"); } } });
    const job = await jobs.enqueue({ userId, type: "boom", payload: {} });
    const { expectAppError } = await import("../../shared/test/errors.test-utils.js");
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

import { sql } from "drizzle-orm";
function sqlAvailableNow(id: string) {
  return sql`update jobs set available_at = '2000-01-01T00:00:00.000Z' where id = ${id}`;
}
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @docmind/server test -- jobs.runner`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the service and runner**

`apps/server/src/modules/jobs/jobs.usecases.ts`:
```ts
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
```

`apps/server/src/modules/jobs/jobs.runner.ts`:
```ts
import type { Database } from "../database/database.js";
import { createLogger, type Logger } from "../../shared/logger/logger.js";
import { backoffMs, isoAfter, nowIso } from "./jobs.models.js";
import { createJobsRepository } from "./jobs.repository.js";
import type { Job } from "./jobs.types.js";

export type JobHandler = (job: Job, ctx: { db: Database }) => Promise<void>;

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
    await Promise.all(claimed.map(process));
    return claimed.length;
  }

  async function start() {
    if (running) return;
    running = true;
    const recovered = await repository.resetProcessingToPending();
    if (recovered > 0) logger.info({ recovered }, "Reset stuck jobs to pending");
    loop = (async () => {
      while (running) {
        const ran = await runOnce();
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
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @docmind/server test -- jobs`
Expected: PASS, all jobs tests. If `db.run(sql...)` is not available on the Drizzle libsql instance, use `db.$client.execute({ sql: "update jobs set available_at = ? where id = ?", args: ["2000-01-01T00:00:00.000Z", id] })` in the helper instead and say so in the report.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/jobs
git commit -m "feat(jobs): add job runner with handler registry, backoff, and startup recovery"
```

---

### Task 3: Jobs routes

**Files:**
- Create: `apps/server/src/modules/jobs/jobs.routes.ts`, `apps/server/src/modules/jobs/jobs.schemas.ts`
- Modify: `apps/server/src/server.ts`
- Test: `apps/server/src/modules/jobs/jobs.routes.test.ts`

**Interfaces:**
- `GET /api/jobs?status=failed` returns `{ jobs: Job[] }` with `payload` parsed to an object in the response.
- `POST /api/jobs/:id/retry` returns `{ job }` or 404 / 409 with codes as in Task 2.
- `registerJobsRoutes({ app, jobsService, getUserId })`.
- `server.ts` creates `jobsService = createJobsService({ db })`, registers the routes after the documents routes, and adds `jobsService` to the returned object. The runner is wired in Task 6 once a handler exists.

- [ ] **Step 1: Write the failing test**

`apps/server/src/modules/jobs/jobs.routes.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";
import { createJobRunner } from "./jobs.runner.js";

describe("jobs routes", () => {
  it("lists jobs with parsed payloads, filters by status, and retries failed ones", async () => {
    const { app, db, services, signIn } = await createTestApp();
    const { cookie, userId } = await signIn();
    const jobs = services.jobsService;
    const ok = await jobs.enqueue({ userId, type: "echo", payload: { n: 1 } });
    const bad = await jobs.enqueue({ userId, type: "boom", payload: { n: 2 } });
    const runner = createJobRunner({ db, handlers: { echo: async () => {}, boom: async () => { throw new Error("nope"); } } });
    for (let i = 0; i < 3; i += 1) {
      await db.run((await import("drizzle-orm")).sql`update jobs set available_at = '2000-01-01T00:00:00.000Z'`);
      await runner.runOnce();
    }

    const all = await (await app.request("/api/jobs", { headers: { cookie } })).json();
    expect(all.jobs.map((j: { id: string }) => j.id).sort()).toEqual([ok.id, bad.id].sort());
    expect(all.jobs.find((j: { id: string }) => j.id === ok.id)).toMatchObject({ status: "done", payload: { n: 1 } });

    const failed = await (await app.request("/api/jobs?status=failed", { headers: { cookie } })).json();
    expect(failed.jobs.map((j: { id: string }) => j.id)).toEqual([bad.id]);
    expect(failed.jobs[0].error).toBe("nope");

    const retried = await app.request(`/api/jobs/${bad.id}/retry`, { method: "POST", headers: { cookie } });
    expect(retried.status).toBe(200);
    expect((await retried.json()).job).toMatchObject({ status: "pending", attempts: 0 });

    const again = await app.request(`/api/jobs/${ok.id}/retry`, { method: "POST", headers: { cookie } });
    expect(again.status).toBe(409);
    expect((await app.request("/api/jobs?status=bogus", { headers: { cookie } })).status).toBe(400);
    expect((await app.request("/api/jobs")).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @docmind/server test -- jobs.routes`
Expected: FAIL, `services.jobsService` undefined or 404s.

- [ ] **Step 3: Write schemas, routes, and wiring**

`apps/server/src/modules/jobs/jobs.schemas.ts`:
```ts
import * as v from "valibot";
import { jobStatusSchema } from "./jobs.models.js";

export const listJobsQuerySchema = v.object({ status: v.optional(jobStatusSchema) });
export const jobIdSchema = v.pipe(v.string(), v.regex(/^job_[0-9a-f]{16}$/));
```

`apps/server/src/modules/jobs/jobs.routes.ts`:
```ts
import type { Context, Hono } from "hono";
import { parseOrValidationError } from "../../shared/http/validate.js";
import { jobIdSchema, listJobsQuerySchema } from "./jobs.schemas.js";
import type { Job } from "./jobs.types.js";
import type { JobsService } from "./jobs.usecases.js";

function present(job: Job) {
  let payload: unknown = {};
  try {
    payload = JSON.parse(job.payload);
  } catch {
    payload = {};
  }
  return { ...job, payload };
}

export function registerJobsRoutes({ app, jobsService, getUserId }: { app: Hono; jobsService: JobsService; getUserId: (c: Context) => string }) {
  app.get("/api/jobs", async (c) => {
    const { status } = parseOrValidationError(listJobsQuerySchema, c.req.query());
    const jobs = await jobsService.list({ userId: getUserId(c), status });
    return c.json({ jobs: jobs.map(present) });
  });

  app.post("/api/jobs/:id/retry", async (c) => {
    const id = parseOrValidationError(jobIdSchema, c.req.param("id"));
    const job = await jobsService.retry({ userId: getUserId(c), id });
    return c.json({ job: present(job) });
  });
}
```

In `apps/server/src/server.ts` add:
```ts
import { registerJobsRoutes } from "./modules/jobs/jobs.routes.js";
import { createJobsService } from "./modules/jobs/jobs.usecases.js";
```
After `documentsService` is created: `const jobsService = createJobsService({ db });`
After `registerDocumentsRoutes(...)`: `registerJobsRoutes({ app, jobsService, getUserId });`
Add `jobsService` to the returned object.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @docmind/server test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src
git commit -m "feat(jobs): add jobs list and retry routes"
```

---

### Task 4: Extractor registry with text, PDF, DOCX, XLSX, and PPTX extractors

**Files:**
- Create: `apps/server/src/modules/extraction/extraction.types.ts`, `extraction.registry.ts`, `extraction.models.ts`
- Create: `apps/server/src/modules/extraction/extractors/text.extractor.ts`, `pdf.extractor.ts`, `docx.extractor.ts`, `xlsx.extractor.ts`, `pptx.extractor.ts`
- Create: `apps/server/src/modules/extraction/test-fixtures.ts` (builds fixture files in memory)
- Test: `apps/server/src/modules/extraction/extraction.registry.test.ts`, `apps/server/src/modules/extraction/extractors/extractors.test.ts`

**Interfaces:**
- `extraction.types.ts`:
  ```ts
  type ExtractInput = { bytes: Uint8Array; mimeType: string; filename: string };
  type ExtractResult = { text: string; note?: string };
  type Extractor = { id: string; mimeTypes: string[]; extract(input: ExtractInput, ctx: ExtractorContext): Promise<ExtractResult> };
  type ExtractorContext = { ocrLanguages: string; dataDir: string };
  ```
- `extraction.registry.ts`: `createExtractorRegistry(extractors: Extractor[])` with `find(mimeType, filename): Extractor | null`. Matching order: exact MIME, then `image/*` wildcard for extractors listing `image/*`, then extension fallback for `.md`, `.txt`, `.pdf`, `.docx`, `.xlsx`, `.pptx` when the MIME type is generic (`application/octet-stream` or empty).
- `extraction.models.ts`: `normalizeText(text)` collapsing runs of more than two blank lines and trimming; `extensionOf(filename)`.
- Extractors:
  - `text`: `text/plain`, `text/markdown`, `text/csv`, `application/json`; decodes UTF-8.
  - `pdf`: `application/pdf`; pdfjs legacy build, joins each page's `items[].str` with spaces, pages separated by a blank line; if the total text is empty returns `{ text: "", note: "No text layer found. OCR for scanned PDFs is not available yet." }`.
  - `docx`: `application/vnd.openxmlformats-officedocument.wordprocessingml.document`; mammoth `extractRawText({ buffer })`.
  - `xlsx`: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`; exceljs, one line per row with cells joined by tabs, sheets separated by a heading line `# <sheet name>`.
  - `pptx`: `application/vnd.openxmlformats-officedocument.presentationml.presentation`; jszip, reads `ppt/slides/slideN.xml` in numeric order and collects every `<a:t>` element's text, one line per paragraph, slides separated by `# Slide N`.
- The image extractor is Task 5 because it needs an injectable OCR worker.

- [ ] **Step 1: Add dependencies**

```bash
pnpm --filter @docmind/server add pdfjs-dist mammoth exceljs jszip
```

- [ ] **Step 2: Write the fixture builder**

`apps/server/src/modules/extraction/test-fixtures.ts`:
```ts
import ExcelJS from "exceljs";
import JSZip from "jszip";

// A minimal single-page PDF with a Helvetica text object. Offsets in the xref table are
// not exact; pdf.js tolerates that by reconstructing the table.
export function pdfWithText(text: string): Uint8Array {
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const pdf = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "xref\n0 6\n0000000000 65535 f \n0000000010 00000 n \n0000000060 00000 n \n0000000120 00000 n \n0000000260 00000 n \n0000000360 00000 n \n",
    "trailer << /Size 6 /Root 1 0 R >>\nstartxref\n420\n%%EOF",
  ].join("\n");
  return new TextEncoder().encode(pdf);
}

export function pdfWithoutText(): Uint8Array {
  return pdfWithText("");
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export async function docxWithParagraphs(paragraphs: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", `${XML_HEADER}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "uint8array" });
}

export async function xlsxWithRows(sheetName: string, rows: (string | number)[][]): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  for (const row of rows) sheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

export async function pptxWithSlides(slides: string[][]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
  slides.forEach((paragraphs, i) => {
    const shapes = paragraphs.map((p) => `<p:sp><p:txBody><a:p><a:r><a:t>${p}</a:t></a:r></a:p></p:txBody></p:sp>`).join("");
    zip.file(`ppt/slides/slide${i + 1}.xml`, `${XML_HEADER}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`);
  });
  return zip.generateAsync({ type: "uint8array" });
}
```

- [ ] **Step 3: Write the failing tests**

`apps/server/src/modules/extraction/extraction.registry.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createExtractorRegistry } from "./extraction.registry.js";
import type { Extractor } from "./extraction.types.js";

const stub = (id: string, mimeTypes: string[]): Extractor => ({ id, mimeTypes, extract: async () => ({ text: id }) });

describe("extractor registry", () => {
  const registry = createExtractorRegistry([
    stub("text", ["text/plain", "text/markdown"]),
    stub("pdf", ["application/pdf"]),
    stub("image", ["image/*"]),
  ]);

  it("matches exact MIME types", () => {
    expect(registry.find("application/pdf", "x.bin")?.id).toBe("pdf");
  });

  it("matches image wildcards", () => {
    expect(registry.find("image/png", "photo.png")?.id).toBe("image");
    expect(registry.find("image/heic", "photo.heic")?.id).toBe("image");
  });

  it("falls back to the extension for generic MIME types", () => {
    expect(registry.find("application/octet-stream", "notes.md")?.id).toBe("text");
    expect(registry.find("", "scan.pdf")?.id).toBe("pdf");
  });

  it("returns null when nothing matches", () => {
    expect(registry.find("application/zip", "archive.zip")).toBeNull();
  });
});
```

`apps/server/src/modules/extraction/extractors/extractors.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { docxWithParagraphs, pdfWithText, pdfWithoutText, pptxWithSlides, xlsxWithRows } from "../test-fixtures.js";
import type { ExtractorContext } from "../extraction.types.js";
import { docxExtractor } from "./docx.extractor.js";
import { pdfExtractor } from "./pdf.extractor.js";
import { pptxExtractor } from "./pptx.extractor.js";
import { textExtractor } from "./text.extractor.js";
import { xlsxExtractor } from "./xlsx.extractor.js";

const ctx: ExtractorContext = { ocrLanguages: "eng", dataDir: "/tmp/unused" };
const bytes = (s: string) => new TextEncoder().encode(s);

describe("extractors", () => {
  it("text decodes UTF-8 and normalizes blank lines", async () => {
    const r = await textExtractor.extract({ bytes: bytes("héllo\n\n\n\n\nworld\n"), mimeType: "text/plain", filename: "a.txt" }, ctx);
    expect(r.text).toBe("héllo\n\nworld");
  });

  it("pdf reads the text layer", async () => {
    const r = await pdfExtractor.extract({ bytes: pdfWithText("Hello DocMind"), mimeType: "application/pdf", filename: "a.pdf" }, ctx);
    expect(r.text).toContain("Hello DocMind");
    expect(r.note).toBeUndefined();
  });

  it("pdf without a text layer finishes with a note", async () => {
    const r = await pdfExtractor.extract({ bytes: pdfWithoutText(), mimeType: "application/pdf", filename: "scan.pdf" }, ctx);
    expect(r.text).toBe("");
    expect(r.note).toMatch(/OCR for scanned PDFs/);
  });

  it("docx reads paragraphs", async () => {
    const r = await docxExtractor.extract({ bytes: await docxWithParagraphs(["First paragraph", "Second paragraph"]), mimeType: docxExtractor.mimeTypes[0]!, filename: "a.docx" }, ctx);
    expect(r.text).toContain("First paragraph");
    expect(r.text).toContain("Second paragraph");
  });

  it("xlsx reads rows with a sheet heading", async () => {
    const r = await xlsxExtractor.extract({ bytes: await xlsxWithRows("Budget", [["Item", "Cost"], ["Rent", 1200]]), mimeType: xlsxExtractor.mimeTypes[0]!, filename: "a.xlsx" }, ctx);
    expect(r.text).toContain("# Budget");
    expect(r.text).toContain("Item\tCost");
    expect(r.text).toContain("Rent\t1200");
  });

  it("pptx reads slide text in order", async () => {
    const r = await pptxExtractor.extract({ bytes: await pptxWithSlides([["Title one"], ["Point a", "Point b"]]), mimeType: pptxExtractor.mimeTypes[0]!, filename: "a.pptx" }, ctx);
    expect(r.text.indexOf("Title one")).toBeLessThan(r.text.indexOf("Point a"));
    expect(r.text).toContain("# Slide 2");
    expect(r.text).toContain("Point b");
  });
});
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `pnpm --filter @docmind/server test -- extraction`
Expected: FAIL, cannot find modules.

- [ ] **Step 5: Write types, models, registry, and the five extractors**

`apps/server/src/modules/extraction/extraction.types.ts`:
```ts
export type ExtractInput = { bytes: Uint8Array; mimeType: string; filename: string };
export type ExtractResult = { text: string; note?: string };
export type ExtractorContext = { ocrLanguages: string; dataDir: string };
export type Extractor = {
  id: string;
  mimeTypes: string[];
  extract(input: ExtractInput, ctx: ExtractorContext): Promise<ExtractResult>;
};
```

`apps/server/src/modules/extraction/extraction.models.ts`:
```ts
import { extname } from "node:path";

export function normalizeText(text: string) {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function extensionOf(filename: string) {
  return extname(filename).toLowerCase();
}

export const EXTENSION_MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

export const GENERIC_MIME = new Set(["", "application/octet-stream", "binary/octet-stream"]);
```

`apps/server/src/modules/extraction/extraction.registry.ts`:
```ts
import { EXTENSION_MIME, GENERIC_MIME, extensionOf } from "./extraction.models.js";
import type { Extractor } from "./extraction.types.js";

export function createExtractorRegistry(extractors: Extractor[]) {
  function byMime(mimeType: string): Extractor | null {
    const exact = extractors.find((e) => e.mimeTypes.includes(mimeType));
    if (exact) return exact;
    const family = `${mimeType.split("/")[0]}/*`;
    return extractors.find((e) => e.mimeTypes.includes(family)) ?? null;
  }

  return {
    find(mimeType: string, filename: string): Extractor | null {
      const normalized = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
      if (!GENERIC_MIME.has(normalized)) {
        const found = byMime(normalized);
        if (found) return found;
      }
      const guessed = EXTENSION_MIME[extensionOf(filename)];
      return guessed ? byMime(guessed) : null;
    },
    all() {
      return [...extractors];
    },
  };
}

export type ExtractorRegistry = ReturnType<typeof createExtractorRegistry>;
```

`apps/server/src/modules/extraction/extractors/text.extractor.ts`:
```ts
import { normalizeText } from "../extraction.models.js";
import type { Extractor } from "../extraction.types.js";

export const textExtractor: Extractor = {
  id: "text",
  mimeTypes: ["text/plain", "text/markdown", "text/csv", "application/json"],
  async extract({ bytes }) {
    return { text: normalizeText(new TextDecoder("utf-8").decode(bytes)) };
  },
};
```

`apps/server/src/modules/extraction/extractors/pdf.extractor.ts`:
```ts
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { normalizeText } from "../extraction.models.js";
import type { Extractor } from "../extraction.types.js";

export const NO_TEXT_LAYER_NOTE = "No text layer found. OCR for scanned PDFs is not available yet.";

export const pdfExtractor: Extractor = {
  id: "pdf",
  mimeTypes: ["application/pdf"],
  async extract({ bytes }) {
    // pdf.js v6 rejects Node Buffers; always hand it a plain Uint8Array copy.
    const data = new Uint8Array(bytes);
    const task = getDocument({ data, useSystemFonts: true, isEvalSupported: false });
    const doc = await task.promise;
    try {
      const pages: string[] = [];
      for (let i = 1; i <= doc.numPages; i += 1) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const line = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ");
        pages.push(line);
      }
      const text = normalizeText(pages.join("\n\n"));
      return text.length > 0 ? { text } : { text: "", note: NO_TEXT_LAYER_NOTE };
    } finally {
      await doc.destroy();
    }
  },
};
```

`apps/server/src/modules/extraction/extractors/docx.extractor.ts`:
```ts
import mammoth from "mammoth";
import { normalizeText } from "../extraction.models.js";
import type { Extractor } from "../extraction.types.js";

export const docxExtractor: Extractor = {
  id: "docx",
  mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  async extract({ bytes }) {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return { text: normalizeText(result.value) };
  },
};
```

`apps/server/src/modules/extraction/extractors/xlsx.extractor.ts`:
```ts
import ExcelJS from "exceljs";
import { normalizeText } from "../extraction.models.js";
import type { Extractor } from "../extraction.types.js";

export const xlsxExtractor: Extractor = {
  id: "xlsx",
  mimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  async extract({ bytes }) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
    const sections: string[] = [];
    workbook.eachSheet((sheet) => {
      const lines: string[] = [`# ${sheet.name}`];
      sheet.eachRow((row) => {
        const cells: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell) => cells.push(cell.text ?? ""));
        lines.push(cells.join("\t"));
      });
      sections.push(lines.join("\n"));
    });
    return { text: normalizeText(sections.join("\n\n")) };
  },
};
```

`apps/server/src/modules/extraction/extractors/pptx.extractor.ts`:
```ts
import JSZip from "jszip";
import { normalizeText } from "../extraction.models.js";
import type { Extractor } from "../extraction.types.js";

function decodeXml(s: string) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export const pptxExtractor: Extractor = {
  id: "pptx",
  mimeTypes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  async extract({ bytes }) {
    const zip = await JSZip.loadAsync(bytes);
    const slideNames = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
    const sections: string[] = [];
    for (const [i, name] of slideNames.entries()) {
      const xml = await zip.file(name)!.async("string");
      const paragraphs = [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)].map((m) =>
        [...m[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decodeXml(t[1]!)).join(""),
      );
      sections.push([`# Slide ${i + 1}`, ...paragraphs.filter((p) => p.trim().length > 0)].join("\n"));
    }
    return { text: normalizeText(sections.join("\n\n")) };
  },
};
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @docmind/server test -- extraction`
Expected: PASS, 4 registry tests and 6 extractor tests. If the hand-built PDF fixture fails to parse, pdf.js prints a warning about the xref table but still reconstructs it; if it throws instead, fix the fixture by computing the byte offsets of each `N 0 obj` in `pdfWithText` and writing them into the xref entries, and say so in the report. If typecheck complains about `pdfjs-dist/legacy/build/pdf.mjs` types, add a file `apps/server/src/modules/extraction/pdfjs.d.ts` declaring the module with `getDocument` typed loosely, and report it.

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "feat(extraction): add extractor registry with text, PDF, DOCX, XLSX, and PPTX extractors"
```

---

### Task 5: Image extractor with injectable OCR, and extraction settings

**Files:**
- Create: `apps/server/src/modules/extraction/extractors/image.extractor.ts`, `apps/server/src/modules/extraction/ocr.ts`, `apps/server/src/modules/extraction/extraction.settings.ts`
- Modify: `apps/server/src/modules/settings/settings.definitions.ts`
- Test: `apps/server/src/modules/extraction/extractors/image.extractor.test.ts`, `apps/server/src/modules/extraction/extraction.settings.test.ts`

**Interfaces:**
- `ocr.ts`: `type OcrEngine = { recognize(bytes: Uint8Array, opts: { languages: string; dataDir: string }): Promise<string> }` and `createTesseractEngine(): OcrEngine`, which lazily creates one tesseract.js worker per language string with `createWorker(languages, 1, { cachePath: dataDir, langPath: "https://tessdata.projectnaptha.com/4.0.0_fast" })`, calls `worker.recognize(Buffer.from(bytes))`, returns `data.text`, and keeps the worker for reuse. `terminate()` shuts workers down.
- `image.extractor.ts`: `createImageExtractor(engine: OcrEngine): Extractor` with `mimeTypes: ["image/*"]`, calling `engine.recognize` with `ctx.ocrLanguages` and `ctx.dataDir`, returning normalized text and the note "No text recognized in this image." when empty.
- `extraction.settings.ts`: `defineSetting` entries `extraction.ocrLanguages` (string, env `OCR_LANGUAGES`, default `"eng"`, doc explains tesseract codes joined with `+`) and `extraction.dataDir` (string, env `DATA_DIR`, default `"./data"`). Exported as `extractionSettingDefinitions`, appended to `allSettingDefinitions`.
- OCR against real tesseract is verified by hand, not in unit tests, because it downloads language data.

- [ ] **Step 1: Write the failing tests**

`apps/server/src/modules/extraction/extractors/image.extractor.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { OcrEngine } from "../ocr.js";
import { createImageExtractor } from "./image.extractor.js";

describe("image extractor", () => {
  it("passes languages and data dir to the engine and normalizes the text", async () => {
    const calls: unknown[] = [];
    const engine: OcrEngine = { recognize: async (bytes, opts) => { calls.push({ len: bytes.length, ...opts }); return "  Total: 42\n\n\n\nThanks  "; }, terminate: async () => {} };
    const extractor = createImageExtractor(engine);
    const r = await extractor.extract({ bytes: new Uint8Array(3), mimeType: "image/png", filename: "receipt.png" }, { ocrLanguages: "eng", dataDir: "/tmp/data" });
    expect(calls).toEqual([{ len: 3, languages: "eng", dataDir: "/tmp/data" }]);
    expect(r.text).toBe("Total: 42\n\nThanks");
    expect(r.note).toBeUndefined();
  });

  it("notes when nothing was recognized", async () => {
    const engine: OcrEngine = { recognize: async () => "   ", terminate: async () => {} };
    const r = await createImageExtractor(engine).extract({ bytes: new Uint8Array(1), mimeType: "image/jpeg", filename: "blank.jpg" }, { ocrLanguages: "eng", dataDir: "/tmp/data" });
    expect(r.text).toBe("");
    expect(r.note).toMatch(/No text recognized/);
  });
});
```

`apps/server/src/modules/extraction/extraction.settings.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { allSettingDefinitions } from "../settings/settings.definitions.js";
import { extractionSettingDefinitions } from "./extraction.settings.js";

describe("extraction settings", () => {
  it("defines OCR languages and data dir with defaults and env seeds", () => {
    const keys = extractionSettingDefinitions.map((d) => d.key);
    expect(keys).toEqual(["extraction.ocrLanguages", "extraction.dataDir"]);
    expect(extractionSettingDefinitions[0]).toMatchObject({ env: "OCR_LANGUAGES", default: "eng", secret: false });
    expect(extractionSettingDefinitions[1]).toMatchObject({ env: "DATA_DIR", default: "./data" });
  });

  it("is registered in the global definitions", () => {
    const keys = allSettingDefinitions.map((d) => d.key);
    expect(keys).toContain("extraction.ocrLanguages");
    expect(keys).toContain("extraction.dataDir");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @docmind/server test -- image.extractor extraction.settings`
Expected: FAIL, cannot find modules.

- [ ] **Step 3: Add the dependency and write the files**

```bash
pnpm --filter @docmind/server add tesseract.js
```

`apps/server/src/modules/extraction/ocr.ts`:
```ts
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createWorker, type Worker } from "tesseract.js";

export type OcrEngine = {
  recognize(bytes: Uint8Array, opts: { languages: string; dataDir: string }): Promise<string>;
  terminate(): Promise<void>;
};

export function createTesseractEngine(): OcrEngine {
  const workers = new Map<string, Promise<Worker>>();

  async function workerFor(languages: string, dataDir: string) {
    const cachePath = resolve(dataDir, "tessdata");
    const key = `${languages}|${cachePath}`;
    let pending = workers.get(key);
    if (!pending) {
      pending = (async () => {
        await mkdir(cachePath, { recursive: true });
        return createWorker(languages, 1, { cachePath, langPath: "https://tessdata.projectnaptha.com/4.0.0_fast" });
      })();
      workers.set(key, pending);
    }
    return pending;
  }

  return {
    async recognize(bytes, { languages, dataDir }) {
      const worker = await workerFor(languages, dataDir);
      const result = await worker.recognize(Buffer.from(bytes));
      return result.data.text;
    },
    async terminate() {
      await Promise.all([...workers.values()].map(async (p) => (await p).terminate()));
      workers.clear();
    },
  };
}
```

`apps/server/src/modules/extraction/extractors/image.extractor.ts`:
```ts
import { normalizeText } from "../extraction.models.js";
import type { Extractor } from "../extraction.types.js";
import type { OcrEngine } from "../ocr.js";

export const NO_TEXT_IN_IMAGE_NOTE = "No text recognized in this image.";

export function createImageExtractor(engine: OcrEngine): Extractor {
  return {
    id: "image",
    mimeTypes: ["image/*"],
    async extract({ bytes }, ctx) {
      const raw = await engine.recognize(bytes, { languages: ctx.ocrLanguages, dataDir: ctx.dataDir });
      const text = normalizeText(raw);
      return text.length > 0 ? { text } : { text: "", note: NO_TEXT_IN_IMAGE_NOTE };
    },
  };
}
```

`apps/server/src/modules/extraction/extraction.settings.ts`:
```ts
import * as v from "valibot";
import { defineSetting } from "../settings/settings.registry.js";

export const extractionSettingDefinitions = [
  defineSetting({
    key: "extraction.ocrLanguages",
    schema: v.pipe(v.string(), v.regex(/^[a-z_]{3,}(\+[a-z_]{3,})*$/, "Use tesseract language codes joined with +, for example eng or eng+deu")),
    env: "OCR_LANGUAGES",
    default: "eng",
    doc: "Tesseract language codes for image OCR, joined with +. Language data downloads on first use.",
  }),
  defineSetting({
    key: "extraction.dataDir",
    schema: v.pipe(v.string(), v.minLength(1)),
    env: "DATA_DIR",
    default: "./data",
    doc: "Directory for downloaded OCR language data and other caches.",
  }),
];
```

In `apps/server/src/modules/settings/settings.definitions.ts`:
```ts
import { extractionSettingDefinitions } from "../extraction/extraction.settings.js";
import { storageSettingDefinitions } from "../storage/storage.settings.js";
import type { SettingDefinition } from "./settings.types.js";

export const allSettingDefinitions: SettingDefinition[] = [...storageSettingDefinitions, ...extractionSettingDefinitions];
```

Add `DATA_DIR=./data` and `OCR_LANGUAGES=eng` to `apps/server/.env.example` under the storage seed, and `/data/` plus `/apps/server/data/` to `.gitignore`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm --filter @docmind/server test && pnpm --filter @docmind/server typecheck`
Expected: PASS. If tesseract.js types do not export `Worker`, use `Awaited<ReturnType<typeof createWorker>>` instead.

- [ ] **Step 5: Commit**

```bash
git add apps/server .gitignore
git commit -m "feat(extraction): add OCR image extractor with injectable engine and extraction settings"
```

---

### Task 6: Extraction job handler, enqueue on upload, re-extract route, and runner wiring

**Files:**
- Create: `apps/server/src/modules/extraction/extraction.usecases.ts`, `apps/server/src/modules/extraction/extraction.routes.ts`
- Modify: `apps/server/src/modules/documents/documents.usecases.ts`, `apps/server/src/modules/documents/documents.repository.ts`, `apps/server/src/server.ts`, `apps/server/src/index.ts`, `apps/server/src/shared/test/app.test-utils.ts`
- Test: `apps/server/src/modules/extraction/extraction.usecases.test.ts`, `apps/server/src/modules/extraction/extraction.routes.test.ts`

**Interfaces:**
- `extraction.usecases.ts`: `createExtractionService({ db, documentsService, settingsService, registry })` with
  - `extractDocument({ userId, documentId })`: loads the document, reads its file stream fully into a `Uint8Array`, finds an extractor (missing one sets `extraction_status = "failed"` with error `No extractor for <mime> (<filename>)` and throws so the job fails), runs it with `ctx` built from settings, and updates the document: `extracted_text`, `extraction_status = "done"`, `extraction_error = note ?? null`, `updated_at`. On any thrown error, sets `extraction_status = "failed"`, `extraction_error = message`, then rethrows so the job records the failure.
  - `handler: JobHandler` for job type `"extraction"` with payload `{ documentId, userId }` calling `extractDocument`.
  - `requestExtraction({ userId, documentId })`: in one transaction sets the document's `extraction_status = "pending"`, `extraction_error = null`, and enqueues an extraction job; returns the job. Used by upload and by the re-extract route.
- `documents.usecases.ts`: `createDocumentsService` gains an optional `onUploaded?: (args: { userId, document, tx }) => Promise<void>` hook; `upload` inserts the row and calls the hook inside one `db.transaction`. `documents.repository.ts` methods accept an optional `tx` for `insert` and `update`.
- `server.ts` builds the registry `[textExtractor, pdfExtractor, docxExtractor, xlsxExtractor, pptxExtractor, createImageExtractor(ocrEngine)]`, creates the extraction service, passes `onUploaded` into the documents service so every upload enqueues extraction, registers `POST /api/documents/:id/extract` (returns `{ job }`), and creates the job runner with `{ extraction: extractionService.handler }`. It returns `jobRunner` too but does not start it; `index.ts` calls `jobRunner.start()` after `serve` and stops it on SIGTERM and SIGINT.
- `app.test-utils.ts` passes a fake `OcrEngine` (returns `"OCR TEXT"`) so tests never download language data; `createTestApp` accepts `{ env, ocrEngine }`.

- [ ] **Step 1: Write the failing usecase test**

`apps/server/src/modules/extraction/extraction.usecases.test.ts`:
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";
import { createJobRunner } from "../jobs/jobs.runner.js";
import { pdfWithText } from "./test-fixtures.js";

let root: string;
let t: Awaited<ReturnType<typeof createTestApp>>;
let userId: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docmind-extract-"));
  t = await createTestApp({ env: { DOCUMENT_STORAGE_ROOT: root } });
  userId = (await t.signIn()).userId;
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("extraction", () => {
  it("upload enqueues an extraction job and the runner fills extracted text", async () => {
    const { document } = await t.services.documentsService.upload({ userId, name: "notes.txt", mimeType: "text/plain", body: Readable.from(["hello extraction"]) });
    const pending = await t.services.jobsService.list({ userId, status: "pending" });
    expect(pending.map((j) => JSON.parse(j.payload).documentId)).toEqual([document.id]);
    expect(await t.services.jobsService.list({ userId })).toHaveLength(1);

    const runner = createJobRunner({ db: t.db, handlers: { extraction: t.services.extractionService.handler } });
    expect(await runner.runOnce()).toBe(1);
    const after = await t.services.documentsService.get({ userId, documentId: document.id });
    expect(after).toMatchObject({ extractionStatus: "done", extractedText: "hello extraction", extractionError: null });
  });

  it("extracts a PDF text layer and records a note for a scanned PDF", async () => {
    const { document } = await t.services.documentsService.upload({ userId, name: "a.pdf", mimeType: "application/pdf", body: Readable.from([Buffer.from(pdfWithText("Invoice 123"))]) });
    const runner = createJobRunner({ db: t.db, handlers: { extraction: t.services.extractionService.handler } });
    await runner.runOnce();
    expect((await t.services.documentsService.get({ userId, documentId: document.id })).extractedText).toContain("Invoice 123");
  });

  it("uses the injected OCR engine for images", async () => {
    const { document } = await t.services.documentsService.upload({ userId, name: "scan.png", mimeType: "image/png", body: Readable.from([Buffer.from([137, 80, 78, 71])]) });
    const runner = createJobRunner({ db: t.db, handlers: { extraction: t.services.extractionService.handler } });
    await runner.runOnce();
    expect((await t.services.documentsService.get({ userId, documentId: document.id })).extractedText).toBe("OCR TEXT");
  });

  it("fails the document and the job when no extractor matches", async () => {
    const { document } = await t.services.documentsService.upload({ userId, name: "archive.zip", mimeType: "application/zip", body: Readable.from(["zip"]) });
    const runner = createJobRunner({ db: t.db, handlers: { extraction: t.services.extractionService.handler } });
    await runner.runOnce();
    const doc = await t.services.documentsService.get({ userId, documentId: document.id });
    expect(doc.extractionStatus).toBe("failed");
    expect(doc.extractionError).toMatch(/No extractor for application\/zip/);
    const [job] = await t.services.jobsService.list({ userId });
    expect(job).toMatchObject({ status: "pending", attempts: 1 });
    expect(job?.error).toMatch(/No extractor/);
  });

  it("requestExtraction resets status to pending and enqueues again", async () => {
    const { document } = await t.services.documentsService.upload({ userId, name: "notes.txt", mimeType: "text/plain", body: Readable.from(["x"]) });
    const runner = createJobRunner({ db: t.db, handlers: { extraction: t.services.extractionService.handler } });
    await runner.runOnce();
    const job = await t.services.extractionService.requestExtraction({ userId, documentId: document.id });
    expect(job.type).toBe("extraction");
    expect((await t.services.documentsService.get({ userId, documentId: document.id })).extractionStatus).toBe("pending");
    expect(await t.services.jobsService.list({ userId })).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Write the failing route test**

`apps/server/src/modules/extraction/extraction.routes.test.ts`:
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";

let root: string;
let t: Awaited<ReturnType<typeof createTestApp>>;
let cookie: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docmind-extract-routes-"));
  t = await createTestApp({ env: { DOCUMENT_STORAGE_ROOT: root } });
  cookie = (await t.signIn()).cookie;
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("re-extract route", () => {
  it("enqueues a new extraction job for a document", async () => {
    const created = await t.app.request("/api/documents?name=a.txt", { method: "POST", headers: { cookie, "content-type": "text/plain", "content-length": "5" }, body: "hello" });
    const { document } = await created.json();
    const res = await t.app.request(`/api/documents/${document.id}/extract`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(202);
    expect((await res.json()).job).toMatchObject({ type: "extraction", status: "pending" });
    const jobs = await (await t.app.request("/api/jobs", { headers: { cookie } })).json();
    expect(jobs.jobs).toHaveLength(2);
    expect((await t.app.request("/api/documents/doc_0000000000000000/extract", { method: "POST", headers: { cookie } })).status).toBe(404);
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `pnpm --filter @docmind/server test -- extraction`
Expected: FAIL: `createTestApp` does not accept the new argument shape, `extractionService` is missing.

- [ ] **Step 4: Write the extraction service and route, then wire everything**

`apps/server/src/modules/extraction/extraction.usecases.ts`:
```ts
import type { Readable } from "node:stream";
import { createError } from "../../shared/errors/errors.js";
import type { Database } from "../database/database.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import type { DocumentsService } from "../documents/documents.usecases.js";
import type { JobHandler } from "../jobs/jobs.runner.js";
import { createJobsService } from "../jobs/jobs.usecases.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import type { ExtractorRegistry } from "./extraction.registry.js";

async function readAll(stream: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const joined = Buffer.concat(chunks);
  return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
}

export function createExtractionService({
  db,
  documentsService,
  settingsService,
  registry,
}: {
  db: Database;
  documentsService: DocumentsService;
  settingsService: SettingsService;
  registry: ExtractorRegistry;
}) {
  const documents = createDocumentsRepository({ db });
  const jobs = createJobsService({ db });

  async function extractDocument({ userId, documentId }: { userId: string; documentId: string }) {
    const now = () => new Date().toISOString();
    try {
      const { document, stream } = await documentsService.openFile({ userId, documentId });
      const extractor = registry.find(document.mimeType ?? "", document.name);
      if (!extractor) {
        throw createError({ code: "extraction.unsupported", message: `No extractor for ${document.mimeType ?? "unknown"} (${document.name})`, status: 422 });
      }
      const bytes = await readAll(stream);
      const ctx = {
        ocrLanguages: (await settingsService.get<string>(userId, "extraction.ocrLanguages")) ?? "eng",
        dataDir: (await settingsService.get<string>(userId, "extraction.dataDir")) ?? "./data",
      };
      const result = await extractor.extract({ bytes, mimeType: document.mimeType ?? "", filename: document.name }, ctx);
      await documents.update({ userId, documentId, patch: { extractedText: result.text, extractionStatus: "done", extractionError: result.note ?? null, updatedAt: now() } });
    } catch (error) {
      const message = ((error as Error).message ?? String(error)).slice(0, 2000);
      await documents.update({ userId, documentId, patch: { extractionStatus: "failed", extractionError: message, updatedAt: now() } });
      throw error;
    }
  }

  const handler: JobHandler = async (job) => {
    const payload = JSON.parse(job.payload) as { documentId: string; userId: string };
    await extractDocument({ userId: payload.userId ?? job.userId, documentId: payload.documentId });
  };

  async function requestExtraction({ userId, documentId }: { userId: string; documentId: string }) {
    await documentsService.get({ userId, documentId });
    return db.transaction(async (tx) => {
      await documents.update({ userId, documentId, patch: { extractionStatus: "pending", extractionError: null, updatedAt: new Date().toISOString() }, tx });
      return jobs.enqueue({ userId, type: "extraction", payload: { documentId, userId }, tx });
    });
  }

  return { extractDocument, handler, requestExtraction };
}

export type ExtractionService = ReturnType<typeof createExtractionService>;
```

`apps/server/src/modules/extraction/extraction.routes.ts`:
```ts
import type { Context, Hono } from "hono";
import { parseOrValidationError } from "../../shared/http/validate.js";
import { documentIdSchema } from "../documents/documents.schemas.js";
import type { ExtractionService } from "./extraction.usecases.js";

export function registerExtractionRoutes({ app, extractionService, getUserId }: { app: Hono; extractionService: ExtractionService; getUserId: (c: Context) => string }) {
  app.post("/api/documents/:id/extract", async (c) => {
    const documentId = parseOrValidationError(documentIdSchema, c.req.param("id"));
    const job = await extractionService.requestExtraction({ userId: getUserId(c), documentId });
    return c.json({ job: { ...job, payload: JSON.parse(job.payload) } }, 202);
  });
}
```

`apps/server/src/modules/documents/documents.repository.ts`: give `insert(document, tx = db)` and `update({ userId, documentId, patch, tx = db })` an optional transaction parameter, using `tx` in place of `db` for that statement. Type it as `tx?: Database` and default to `db`; Drizzle's transaction object is compatible for these calls (cast with `as Database` if TypeScript objects).

`apps/server/src/modules/documents/documents.usecases.ts`: change the factory signature to `createDocumentsService({ db, storageService, onUploaded })` where `onUploaded?: (args: { userId: string; document: Document; tx: Database }) => Promise<void>`. In `upload`, replace `await repository.insert(document);` with:
```ts
await db.transaction(async (tx) => {
  await repository.insert(document, tx as unknown as Database);
  if (onUploaded) await onUploaded({ userId, document, tx: tx as unknown as Database });
});
```

`apps/server/src/server.ts`: accept an optional `ocrEngine` in its argument (`createServer({ config, db, ocrEngine })`, default `createTesseractEngine()`), and build:
```ts
const registry = createExtractorRegistry([textExtractor, pdfExtractor, docxExtractor, xlsxExtractor, pptxExtractor, createImageExtractor(ocrEngine)]);
const jobsService = createJobsService({ db });
let extractionService: ExtractionService;
const documentsService = createDocumentsService({
  db,
  storageService,
  onUploaded: async ({ userId, document, tx }) => {
    await jobsService.enqueue({ userId, type: "extraction", payload: { documentId: document.id, userId }, tx });
  },
});
extractionService = createExtractionService({ db, documentsService, settingsService, registry });
const jobRunner = createJobRunner({ db, handlers: { extraction: extractionService.handler } });
```
Register `registerExtractionRoutes({ app, extractionService, getUserId })` after the documents routes and before the jobs routes, and return `extractionService`, `jobsService`, `jobRunner`, `ocrEngine` alongside the existing fields. Note the upload hook enqueues directly (the document row is already `pending` on insert), while `requestExtraction` resets status first.

`apps/server/src/index.ts`: after `const { app, jobRunner, ocrEngine } = createServer({ config, db });` and `serve(...)`, call `await jobRunner.start();` and register:
```ts
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, "Shutting down");
    await jobRunner.stop();
    await ocrEngine.terminate();
    process.exit(0);
  });
}
```

`apps/server/src/shared/test/app.test-utils.ts`: change the signature to `createTestApp({ env = {}, ocrEngine }: { env?: Record<string, string>; ocrEngine?: OcrEngine } = {})`, default `ocrEngine` to `{ recognize: async () => "OCR TEXT", terminate: async () => {} }`, and pass it to `createServer`. Update the two existing call sites that pass a bare env object (`documents.routes.test.ts` and `server.test.ts` if it passes one) to the new `{ env }` shape.

- [ ] **Step 5: Run the whole server suite and typecheck**

Run: `pnpm --filter @docmind/server test && pnpm --filter @docmind/server typecheck`
Expected: PASS. The runner never starts inside tests because only `index.ts` starts it.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src
git commit -m "feat(extraction): run extraction jobs on upload, add re-extract route, and start the runner"
```

---

### Task 7: Client Jobs page, extracted text panel, and live status

**Files:**
- Create: `apps/client/src/lib/jobs-api.ts`, `apps/client/src/pages/jobs/JobsPage.tsx`
- Modify: `apps/client/src/lib/documents-api.ts`, `apps/client/src/pages/documents/DocumentsPage.tsx`, `apps/client/src/pages/documents/DocumentDetailPage.tsx`, `apps/client/src/App.tsx`
- Test: `apps/client/src/lib/jobs-api.test.ts`, `apps/client/src/pages/jobs/JobsPage.test.tsx`

**Interfaces:**
- `jobs-api.ts`: `JobRow` type; `jobsApi.list(status?)` calling `/api/jobs` with an optional `?status=`; `jobsApi.retry(id)` posting to `/api/jobs/:id/retry`.
- `documents-api.ts`: `DocumentRow` gains `extractedText: string | null`; `documentsApi.reextract(id)` posting to `/api/documents/:id/extract`.
- `JobsPage`: a status filter (All, Pending, Processing, Done, Failed) as buttons, a table with type, document id from the payload, status badge, attempts, created time, error text (full, wrapped), and a Retry button on failed rows. Polls every 3 seconds with TanStack Query's `refetchInterval` while any job is pending or processing, otherwise every 15 seconds.
- `DocumentsPage`: the documents query uses `refetchInterval` of 3 seconds while any row is pending or processing, else off.
- `DocumentDetailPage`: adds a card "Text" under the preview showing the extraction status badge, the note or error text when present, a "Re-extract" button that calls `reextract` and invalidates the document query, and the extracted text in a scrollable `<pre>` with wrapping. The document query polls every 3 seconds while status is pending or processing.
- `App.tsx`: the `/jobs` route renders `JobsPage`.

- [ ] **Step 1: Write the failing tests**

`apps/client/src/lib/jobs-api.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { jobsApi } from "./jobs-api";

afterEach(() => vi.restoreAllMocks());

describe("jobsApi", () => {
  it("lists with an optional status filter", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ jobs: [{ id: "job_1" }] }), { status: 200 }));
    expect(await jobsApi.list("failed")).toEqual([{ id: "job_1" }]);
    expect(spy.mock.calls[0]?.[0]).toBe("/api/jobs?status=failed");
    await jobsApi.list();
    expect(spy.mock.calls[1]?.[0]).toBe("/api/jobs");
  });

  it("retries by id", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ job: { id: "job_1", status: "pending" } }), { status: 200 }));
    expect(await jobsApi.retry("job_1")).toMatchObject({ status: "pending" });
    expect(spy.mock.calls[0]?.[0]).toBe("/api/jobs/job_1/retry");
    expect((spy.mock.calls[0]?.[1] as RequestInit).method).toBe("POST");
  });
});
```

`apps/client/src/pages/jobs/JobsPage.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JobsPage } from "./JobsPage";

const retry = vi.fn(async (id: string) => ({ id, status: "pending" }));
vi.mock("@/lib/jobs-api", () => ({
  jobsApi: {
    list: vi.fn(async () => [
      { id: "job_1", type: "extraction", status: "failed", attempts: 3, error: "No extractor for application/zip", payload: { documentId: "doc_1" }, createdAt: "2026-09-16T10:00:00.000Z" },
      { id: "job_2", type: "extraction", status: "done", attempts: 1, error: null, payload: { documentId: "doc_2" }, createdAt: "2026-09-16T10:01:00.000Z" },
    ]),
    retry: (id: string) => retry(id),
  },
}));

describe("JobsPage", () => {
  it("shows jobs with errors and retries failed ones", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <JobsPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/No extractor for application\/zip/)).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: /retry/i });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(retry).toHaveBeenCalledWith("job_1"));
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @docmind/client test`
Expected: FAIL, cannot find modules.

- [ ] **Step 3: Write the API, page, and edits**

`apps/client/src/lib/jobs-api.ts`:
```ts
import { api } from "./api";

export type JobRow = {
  id: string;
  type: string;
  status: "pending" | "processing" | "done" | "failed";
  attempts: number;
  error: string | null;
  payload: { documentId?: string; [key: string]: unknown };
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
};

export const jobsApi = {
  async list(status?: JobRow["status"]) {
    const path = status ? `/api/jobs?status=${encodeURIComponent(status)}` : "/api/jobs";
    return (await api.get<{ jobs: JobRow[] }>(path)).jobs;
  },
  async retry(id: string) {
    return (await api.json<{ job: JobRow }>("POST", `/api/jobs/${id}/retry`, {})).job;
  },
};
```

In `apps/client/src/lib/documents-api.ts`, add `extractedText: string | null;` to `DocumentRow` and this method to `documentsApi`:
```ts
  async reextract(id: string) {
    return (await api.json<{ job: { id: string; status: string } }>("POST", `/api/documents/${id}/extract`, {})).job;
  },
```

`apps/client/src/pages/jobs/JobsPage.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { jobsApi, type JobRow } from "@/lib/jobs-api";
import { formatDate } from "@/lib/format";

const FILTERS: { label: string; value?: JobRow["status"] }[] = [
  { label: "All" },
  { label: "Pending", value: "pending" },
  { label: "Processing", value: "processing" },
  { label: "Done", value: "done" },
  { label: "Failed", value: "failed" },
];

function statusVariant(status: JobRow["status"]) {
  if (status === "failed") return "destructive" as const;
  if (status === "done") return "secondary" as const;
  return "default" as const;
}

export function JobsPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<JobRow["status"] | undefined>(undefined);
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ["jobs", status ?? "all"],
    queryFn: () => jobsApi.list(status),
    refetchInterval: (query) => (query.state.data?.some((j) => j.status === "pending" || j.status === "processing") ? 3000 : 15000),
  });
  const retry = useMutation({
    mutationFn: (id: string) => jobsApi.retry(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      toast.success("Retry queued");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Jobs</h1>
      <div className="flex gap-2 flex-wrap">
        {FILTERS.map((f) => (
          <Button key={f.label} size="sm" variant={f.value === status ? "default" : "outline"} onClick={() => setStatus(f.value)}>
            {f.label}
          </Button>
        ))}
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading</p>
      ) : jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No jobs yet. Upload a document and its extraction shows up here.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>Document</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Attempts</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Error</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((j) => (
              <TableRow key={j.id}>
                <TableCell>{j.type}</TableCell>
                <TableCell>
                  {j.payload.documentId ? (
                    <Link className="underline-offset-2 hover:underline" to={`/documents/${j.payload.documentId}`}>
                      {j.payload.documentId}
                    </Link>
                  ) : (
                    ""
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(j.status)}>{j.status}</Badge>
                </TableCell>
                <TableCell>{j.attempts}</TableCell>
                <TableCell>{formatDate(j.createdAt)}</TableCell>
                <TableCell className="max-w-md whitespace-pre-wrap break-words text-sm text-muted-foreground">{j.error ?? ""}</TableCell>
                <TableCell>
                  {j.status === "failed" && (
                    <Button size="sm" variant="outline" onClick={() => retry.mutate(j.id)} disabled={retry.isPending}>
                      Retry
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
```

In `apps/client/src/pages/documents/DocumentsPage.tsx`, change the query to poll while work is pending:
```tsx
const { data: documents = [], isLoading } = useQuery({
  queryKey: ["documents"],
  queryFn: documentsApi.list,
  refetchInterval: (query) => (query.state.data?.some((d) => d.extractionStatus === "pending" || d.extractionStatus === "processing") ? 3000 : false),
});
```

In `apps/client/src/pages/documents/DocumentDetailPage.tsx`:
- Change the document query to `useQuery({ queryKey: ["documents", id], queryFn: () => documentsApi.get(id), refetchInterval: (q) => (q.state.data && (q.state.data.extractionStatus === "pending" || q.state.data.extractionStatus === "processing") ? 3000 : false) })`.
- Add a mutation:
```tsx
const reextract = useMutation({
  mutationFn: () => documentsApi.reextract(id),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ["documents", id] });
    queryClient.invalidateQueries({ queryKey: ["jobs"] });
    toast.success("Extraction queued");
  },
  onError: (e: Error) => toast.error(e.message),
});
```
- Add imports for `Badge` and `Card, CardContent, CardHeader, CardTitle`, and render this card after `<Preview ... />`:
```tsx
<Card>
  <CardHeader className="flex flex-row items-center justify-between space-y-0">
    <CardTitle className="text-base flex items-center gap-2">
      Text
      <Badge variant={document.extractionStatus === "failed" ? "destructive" : "secondary"}>{document.extractionStatus}</Badge>
    </CardTitle>
    <Button size="sm" variant="outline" onClick={() => reextract.mutate()} disabled={reextract.isPending}>
      Re-extract
    </Button>
  </CardHeader>
  <CardContent>
    {document.extractionError && <p className="text-sm text-muted-foreground mb-2">{document.extractionError}</p>}
    {document.extractedText ? (
      <pre className="whitespace-pre-wrap break-words text-sm max-h-[50vh] overflow-auto">{document.extractedText}</pre>
    ) : (
      <p className="text-sm text-muted-foreground">
        {document.extractionStatus === "done" ? "No text was found in this document." : "Text appears here once extraction finishes."}
      </p>
    )}
  </CardContent>
</Card>
```

In `apps/client/src/App.tsx`, import `JobsPage` from `@/pages/jobs/JobsPage` and replace the `/jobs` placeholder route with `<Route path="/jobs" element={<JobsPage />} />`.

- [ ] **Step 4: Run tests, typecheck, and build**

Run: `pnpm --filter @docmind/client test && pnpm --filter @docmind/client typecheck && pnpm --filter @docmind/client build`
Expected: PASS, 8 client tests.

- [ ] **Step 5: Commit**

```bash
git add apps/client
git commit -m "feat(client): add jobs page, extracted text panel, re-extract, and live status polling"
```

---

### Task 8: Docs and milestone wrap-up

**Files:**
- Modify: `CLAUDE.md` ("Running locally" section), `apps/server/.env.example`

**Interfaces:** none.

- [ ] **Step 1: Update the docs**

In `CLAUDE.md` "Running locally", after the `pnpm dev` line add:
```
Background jobs run inside the server process. OCR language data downloads into
DATA_DIR (default ./data) on the first image upload; the first OCR takes longer.
```
Confirm `.env.example` lists `DATA_DIR=./data` and `OCR_LANGUAGES=eng` from Task 5.

- [ ] **Step 2: Full verification**

Run from the repo root: `pnpm test && pnpm typecheck && pnpm build`. All green.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md apps/server/.env.example
git commit -m "docs: describe background jobs and OCR data for local runs"
```

Milestone B is complete when the suite passes, a manual run shows an uploaded text file, PDF, and image reaching `done` with text on the document page, a ZIP reaching `failed` with a readable error in Jobs, and Retry re-queuing it.
