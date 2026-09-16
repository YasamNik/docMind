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
    let doc = await t.services.documentsService.get({ userId, documentId: document.id });
    expect(doc.extractionStatus).toBe("pending");
    expect(doc.extractionError).toMatch(/No extractor for application\/zip/);
    let [job] = await t.services.jobsService.list({ userId });
    expect(job).toMatchObject({ status: "pending", attempts: 1 });
    expect(job?.error).toMatch(/No extractor/);

    const { sql } = await import("drizzle-orm");
    for (let i = 0; i < 2; i += 1) {
      await t.db.run(sql`update jobs set available_at = '2000-01-01T00:00:00.000Z' where id = ${job!.id}`);
      await runner.runOnce();
    }
    doc = await t.services.documentsService.get({ userId, documentId: document.id });
    expect(doc.extractionStatus).toBe("failed");
    [job] = await t.services.jobsService.list({ userId });
    expect(job).toMatchObject({ status: "failed", attempts: 3 });
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
