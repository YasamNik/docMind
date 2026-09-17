import { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";
import { createJobRunner } from "../jobs/jobs.runner.js";
import type { AiAdapter, ModelInfo, StructuredResult, TestResult } from "../ai/ai.types.js";

function fakeAdapter(replyRef: { current: unknown }): AiAdapter {
  return {
    generateStructured: vi.fn(async () => ({ data: replyRef.current, usage: { promptTokens: 10, completionTokens: 10 } }) as StructuredResult),
    streamText: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    embed: vi.fn(async () => ({ vectors: [], dimension: 0 })),
    listModels: vi.fn(async () => [] as ModelInfo[]),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1, message: "ok" }) as TestResult),
  };
}

async function setup() {
  const replyRef = { current: { items: [] } as unknown };
  const adapter = fakeAdapter(replyRef);
  const t = await createTestApp({ adapterFactories: { "openai-compatible": () => adapter, "anthropic": () => adapter } });
  const { cookie, userId } = await t.signIn();
  await t.services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test", "ai.model.rules": "openrouter://test-model" });
  const runner = createJobRunner({ db: t.db, handlers: { rules: t.services.rulesService.handler } });
  return { t, cookie, userId, replyRef, runner };
}

async function uploadWithText(t: Awaited<ReturnType<typeof setup>>["t"], userId: string, text: string) {
  const { document } = await t.services.documentsService.upload({ userId, name: "invoice.txt", mimeType: "text/plain", body: Readable.from([text]) });
  await t.db.run(sql`update documents set extracted_text = ${text}, extraction_status = 'done', rule_status = 'done' where id = ${document.id}`);
  return document.id;
}

const jsonHeaders = (cookie: string) => ({ cookie, "content-type": "application/json" });

describe("rules routes", () => {
  it("requires a session on every route", async () => {
    const { app } = await createTestApp();
    expect((await app.request("/api/documents/doc_0000000000000000/sort", { method: "POST" })).status).toBe(401);
    expect((await app.request("/api/documents/doc_0000000000000000/proposals")).status).toBe(401);
    expect((await app.request("/api/sort/run", { method: "POST" })).status).toBe(401);
    expect((await app.request("/api/sort/count?scope=all")).status).toBe(401);
    expect((await app.request("/api/sort/dry-run", { method: "POST" })).status).toBe(401);
    expect((await app.request("/api/proposals")).status).toBe(401);
    expect((await app.request("/api/proposals/apply", { method: "POST" })).status).toBe(401);
  });

  it("enqueues a rerun job for a document over HTTP", async () => {
    const { t, cookie, userId } = await setup();
    const documentId = await uploadWithText(t, userId, "Invoice");
    const res = await t.app.request(`/api/documents/${documentId}/sort`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job.type).toBe("rules");
    expect(body.job.payload).toMatchObject({ documentId, mode: "rerun" });
  });

  it("lists and applies a proposal over HTTP", async () => {
    const { t, cookie, userId, replyRef, runner } = await setup();
    const category = await t.services.tagsService.createCategory({ userId, name: "Finance", description: "Money matters" });
    const documentId = await uploadWithText(t, userId, "Invoice text");
    replyRef.current = { items: [{ type: "category", id: category.id, matched: true, confidence: 0.9, reasoning: "It is an invoice." }] };
    await t.app.request("/api/sort/run", {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ targetType: "category", targetId: category.id, scope: "all" }),
    });
    await runner.runOnce();

    const listed = await (await t.app.request(`/api/documents/${documentId}/proposals`, { headers: { cookie } })).json();
    expect(listed.proposals).toHaveLength(1);

    const allProposals = await (await t.app.request("/api/proposals", { headers: { cookie } })).json();
    expect(allProposals.proposals).toHaveLength(1);
    expect(allProposals.nextCursor).toBeNull();

    const applied = await t.app.request("/api/proposals/apply", {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ accept: [listed.proposals[0].id], dismiss: [] }),
    });
    expect((await applied.json())).toEqual({ appliedCount: 1, dismissedCount: 0 });

    const document = await (await t.app.request(`/api/documents/${documentId}`, { headers: { cookie } })).json();
    expect(document.document.categoryId).toBe(category.id);
  });

  it("counts and runs over a scope", async () => {
    const { t, cookie, userId } = await setup();
    const tag = await t.services.tagsService.createTag({ userId, name: "Rent", description: "Monthly rent" });
    await uploadWithText(t, userId, "a");
    await uploadWithText(t, userId, "b");
    const count = await (await t.app.request("/api/sort/count?scope=all", { headers: { cookie } })).json();
    expect(count.count).toBe(2);
    const run = await t.app.request("/api/sort/run", {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ targetType: "tag", targetId: tag.id, scope: "all" }),
    });
    const runBody = await run.json();
    expect(runBody.count).toBe(2);
    expect(runBody.jobIds).toHaveLength(2);
  });

  it("rejects an invalid scope", async () => {
    const { t, cookie } = await setup();
    const res = await t.app.request("/api/sort/count?scope=bogus", { headers: { cookie } });
    expect(res.status).toBe(400);
  });

  it("runs a dry run synchronously and stores nothing", async () => {
    const { t, cookie, userId, replyRef } = await setup();
    const documentId = await uploadWithText(t, userId, "Invoice for March rent");
    replyRef.current = { items: [{ type: "tag", id: "draft", matched: true, confidence: 0.8, reasoning: "Mentions rent." }] };
    const res = await t.app.request("/api/sort/dry-run", {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ documentId, targetType: "tag", name: "Rent", description: "Monthly rent", threshold: 0.7 }),
    });
    expect(await res.json()).toEqual({ matched: true, confidence: 0.8, reasoning: "Mentions rent.", wouldApply: true });
    const jobs = await t.services.jobsService.list({ userId });
    expect(jobs.filter((j) => j.type === "rules")).toHaveLength(0);
  });

  it("includes a document with a pending proposal in needs_review even when it has a category", async () => {
    const { t, cookie, userId, replyRef, runner } = await setup();
    const current = await t.services.tagsService.createCategory({ userId, name: "Personal" });
    const tag = await t.services.tagsService.createTag({ userId, name: "Rent", description: "Monthly rent" });
    const documentId = await uploadWithText(t, userId, "Invoice text");
    await t.services.tagsService.setDocumentCategory({ userId, documentId, categoryId: current.id });
    replyRef.current = { items: [{ type: "tag", id: tag.id, matched: true, confidence: 0.9, reasoning: "Mentions rent." }] };
    await t.services.jobsService.enqueue({ userId, type: "rules", payload: { documentId, userId, mode: "rerun", targetType: "tag", targetId: tag.id } });
    await runner.runOnce();

    const list = await (await t.app.request("/api/documents?view=needs_review", { headers: { cookie } })).json();
    expect(list.documents.map((d: { id: string }) => d.id)).toContain(documentId);
  });
});
