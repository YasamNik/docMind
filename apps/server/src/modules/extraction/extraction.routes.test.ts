import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";
import { createJobRunner } from "../jobs/jobs.runner.js";

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
  it("enqueues a new extraction job for a document once the prior job is no longer active", async () => {
    const created = await t.app.request("/api/documents?name=a.txt", { method: "POST", headers: { cookie, "content-type": "text/plain", "content-length": "5" }, body: "hello" });
    const { document } = await created.json();

    const runner = createJobRunner({ db: t.db, handlers: { extraction: t.services.extractionService.handler } });
    await runner.runOnce();

    const res = await t.app.request(`/api/documents/${document.id}/extract`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(202);
    expect((await res.json()).job).toMatchObject({ type: "extraction", status: "pending" });
    const jobs = await (await t.app.request("/api/jobs", { headers: { cookie } })).json();
    expect(jobs.jobs).toHaveLength(2);
    expect((await t.app.request("/api/documents/doc_0000000000000000/extract", { method: "POST", headers: { cookie } })).status).toBe(404);
  });

  it("returns the existing job when one is already pending for the document", async () => {
    const created = await t.app.request("/api/documents?name=a.txt", { method: "POST", headers: { cookie, "content-type": "text/plain", "content-length": "5" }, body: "hello" });
    const { document } = await created.json();

    const res = await t.app.request(`/api/documents/${document.id}/extract`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(202);
    const jobs = await (await t.app.request("/api/jobs", { headers: { cookie } })).json();
    expect(jobs.jobs).toHaveLength(1);
  });
});
