import { describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";
import type { AiAdapter, ModelInfo, StructuredResult, TestResult } from "../ai/ai.types.js";

function fakeAdapter(replyRef: { current: unknown }): AiAdapter {
  return {
    generateStructured: vi.fn(async () => ({ data: replyRef.current, usage: { promptTokens: 10, completionTokens: 10 } }) as StructuredResult),
    streamText: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    streamChat: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    embed: vi.fn(async () => ({ vectors: [], dimension: 0 })),
    recognizeImage: vi.fn(async () => ({ text: "" })),
    listModels: vi.fn(async () => [] as ModelInfo[]),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1, message: "ok" }) as TestResult),
  };
}

describe("tags and categories routes", () => {
  it("requires a session on every route", async () => {
    const { app } = await createTestApp();
    expect((await app.request("/api/tags")).status).toBe(401);
    expect((await app.request("/api/categories")).status).toBe(401);
    expect((await app.request("/api/tags/description-assistant", { method: "POST" })).status).toBe(401);
  });

  it("creates, lists, updates, and deletes a tag over HTTP", async () => {
    const { app, signIn } = await createTestApp();
    const { cookie } = await signIn();

    const created = await app.request("/api/tags", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Rent", color: "#4f46e5" }),
    });
    expect(created.status).toBe(201);
    const { tag } = await created.json();
    expect(tag).toMatchObject({ name: "Rent", color: "#4f46e5", autoApply: true, confidenceThreshold: 0.7, documentCount: 0 });

    const list = await (await app.request("/api/tags", { headers: { cookie } })).json();
    expect(list.tags.map((t: { id: string }) => t.id)).toEqual([tag.id]);

    const updated = await app.request(`/api/tags/${tag.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ description: "Monthly rent payments" }),
    });
    expect((await updated.json()).tag.description).toBe("Monthly rent payments");

    expect((await app.request(`/api/tags/${tag.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
    expect((await (await app.request("/api/tags", { headers: { cookie } })).json()).tags).toEqual([]);
  });

  it("rejects an invalid tag body and a duplicate name", async () => {
    const { app, signIn } = await createTestApp();
    const { cookie } = await signIn();
    const empty = await app.request("/api/tags", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "" }) });
    expect(empty.status).toBe(400);
    await app.request("/api/tags", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Rent" }) });
    const dup = await app.request("/api/tags", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "rent" }) });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.code).toBe("tags.duplicate_name");

    const tooLongName = await app.request("/api/tags", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "a".repeat(61) }),
    });
    expect(tooLongName.status).toBe(400);

    const badThreshold = await app.request("/api/tags", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Utilities", confidenceThreshold: 1.5 }),
    });
    expect(badThreshold.status).toBe(400);
  });

  it("creates nested categories, moves one, and rejects a cycle", async () => {
    const { app, signIn } = await createTestApp();
    const { cookie } = await signIn();

    const finance = await (
      await app.request("/api/categories", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Finance" }) })
    ).json();
    const tax = await (
      await app.request("/api/categories", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Tax", parentId: finance.category.id }),
      })
    ).json();
    expect(tax.category.path).toBe("Finance / Tax");

    const cycle = await app.request(`/api/categories/${finance.category.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ parentId: tax.category.id }),
    });
    expect(cycle.status).toBe(400);
    expect((await cycle.json()).error.code).toBe("categories.invalid_parent");

    const list = await (await app.request("/api/categories", { headers: { cookie } })).json();
    expect(list.categories.map((c: { id: string }) => c.id).sort()).toEqual([finance.category.id, tax.category.id].sort());

    expect((await app.request(`/api/categories/${tax.category.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
  });

  it("reorders two categories in a single request", async () => {
    const { app, signIn } = await createTestApp();
    const { cookie } = await signIn();

    const first = await (
      await app.request("/api/categories", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "zzz" }) })
    ).json();
    const second = await (
      await app.request("/api/categories", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "aaa" }) })
    ).json();

    const reordered = await app.request("/api/categories/reorder", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ a: { id: first.category.id, sortOrder: 1 }, b: { id: second.category.id, sortOrder: 0 } }),
    });
    expect(reordered.status).toBe(200);

    const list = await (await app.request("/api/categories", { headers: { cookie } })).json();
    expect(list.categories.map((c: { id: string }) => c.id)).toEqual([second.category.id, first.category.id]);
  });

  it("sets and clears a document's category and tags", async () => {
    const { app, signIn, services } = await createTestApp();
    const { cookie, userId } = await signIn();
    const { document } = await services.documentsService.upload({ userId, name: "a.txt", mimeType: "text/plain", body: (await import("node:stream")).Readable.from(["a"]) });
    const category = (
      await (
        await app.request("/api/categories", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Finance" }) })
      ).json()
    ).category;
    const tag = (
      await (await app.request("/api/tags", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Rent" }) })).json()
    ).tag;

    const setCategory = await app.request(`/api/documents/${document.id}/category`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ categoryId: category.id }),
    });
    const setCategoryBody = await setCategory.json();
    expect(setCategoryBody.document).toMatchObject({ categoryId: category.id, categorySource: "manual" });
    expect(Object.keys(setCategoryBody.document)).not.toContain("extractedText");
    expect(setCategoryBody.document.categoryPath).toBe("Finance");
    expect(setCategoryBody.document.tags).toEqual([]);

    const addTag = await app.request(`/api/documents/${document.id}/tags/${tag.id}`, { method: "POST", headers: { cookie } });
    expect((await addTag.json()).tags).toEqual([{ id: tag.id, name: "Rent", color: null, auto: false, manual: true }]);

    const removeTag = await app.request(`/api/documents/${document.id}/tags/${tag.id}`, { method: "DELETE", headers: { cookie } });
    expect((await removeTag.json()).tags).toEqual([]);

    const clearCategory = await app.request(`/api/documents/${document.id}/category`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ categoryId: null }),
    });
    const clearCategoryBody = await clearCategory.json();
    expect(clearCategoryBody.document).toMatchObject({ categoryId: null, categorySource: null });
    expect(Object.keys(clearCategoryBody.document)).not.toContain("extractedText");

    const missing = await app.request(`/api/documents/doc_0000000000000000/category`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ categoryId: null }),
    });
    expect(missing.status).toBe(404);
  });

  it("returns a description suggestion trimmed to 300 characters over HTTP", async () => {
    const replyRef = { current: { description: `${"word ".repeat(80)}tail` } as unknown };
    const adapter = fakeAdapter(replyRef);
    const t = await createTestApp({ adapterFactories: { "openai-compatible": () => adapter, "anthropic": () => adapter } });
    const { cookie, userId } = await t.signIn();
    await t.services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test", "ai.model.rules": "openrouter://test-model" });

    const res = await t.app.request("/api/tags/description-assistant", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ targetType: "tag", name: "Medical", description: "" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.suggestion).toBe("string");
    expect(body.suggestion.length).toBeLessThanOrEqual(300);
  });

  it("accepts targetType type for the description assistant, capped at 2000 characters", async () => {
    const replyRef = { current: { description: `${"word ".repeat(500)}tail` } as unknown };
    const adapter = fakeAdapter(replyRef);
    const t = await createTestApp({ adapterFactories: { "openai-compatible": () => adapter, "anthropic": () => adapter } });
    const { cookie, userId } = await t.signIn();
    await t.services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-test", "ai.model.rules": "openrouter://test-model" });

    const res = await t.app.request("/api/tags/description-assistant", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ targetType: "type", name: "Quote", description: "" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestion.length).toBeLessThanOrEqual(2000);
  });

  it("returns a clean error when no rules model is configured", async () => {
    const { app, signIn } = await createTestApp();
    const { cookie } = await signIn();
    const res = await app.request("/api/tags/description-assistant", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ targetType: "tag", name: "Medical", description: "" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("ai.slot_not_configured");
  });

  it("validates the description assistant body", async () => {
    const { app, signIn } = await createTestApp();
    const { cookie } = await signIn();
    const res = await app.request("/api/tags/description-assistant", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ targetType: "widget", name: "Medical", description: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates, lists, updates, and deletes a document type over HTTP", async () => {
    const { app, signIn } = await createTestApp();
    const { cookie } = await signIn();

    const created = await app.request("/api/types", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Quote", color: "#4f46e5" }),
    });
    expect(created.status).toBe(201);
    const { type } = await created.json();
    expect(type).toMatchObject({ name: "Quote", color: "#4f46e5", autoApply: true, confidenceThreshold: 0.7, documentCount: 0 });

    const list = await (await app.request("/api/types", { headers: { cookie } })).json();
    expect(list.types.map((x: { id: string }) => x.id)).toContain(type.id);

    const updated = await app.request(`/api/types/${type.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ description: "A price offered before any work is done." }),
    });
    expect((await updated.json()).type.description).toBe("A price offered before any work is done.");

    expect((await app.request(`/api/types/${type.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
    expect((await (await app.request("/api/types", { headers: { cookie } })).json()).types.map((x: { id: string }) => x.id)).not.toContain(type.id);
  });

  it("rejects an invalid type body and a duplicate name", async () => {
    const { app, signIn } = await createTestApp();
    const { cookie } = await signIn();
    const empty = await app.request("/api/types", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "" }) });
    expect(empty.status).toBe(400);
    await app.request("/api/types", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Quote" }) });
    const dup = await app.request("/api/types", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "quote" }) });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.code).toBe("types.duplicate_name");
  });

  it("sets a document's type, records a correction, and returns the type name on every enriched document response", async () => {
    const { app, db, signIn, services } = await createTestApp();
    const { cookie, userId } = await signIn();
    const { document } = await services.documentsService.upload({ userId, name: "a.txt", mimeType: "text/plain", body: (await import("node:stream")).Readable.from(["a"]) });
    const type = (
      await (await app.request("/api/types", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Quote" }) })).json()
    ).type;

    const setType = await app.request(`/api/documents/${document.id}/type`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ documentTypeId: type.id }),
    });
    const setTypeBody = await setType.json();
    expect(setTypeBody.document).toMatchObject({ documentTypeId: type.id, documentTypeSource: "manual", documentTypeName: "Quote" });
    expect(Object.keys(setTypeBody.document)).not.toContain("extractedText");

    // recordCorrection is fired without being awaited by the route (matching the
    // category and tag routes), so its write can land a tick after the response does.
    const { createRulesRepository } = await import("../rules/rules.repository.js");
    const rulesRepository = createRulesRepository({ db });
    await vi.waitFor(async () => {
      const correction = await rulesRepository.listExamplesForTarget({ targetType: "type", targetId: type.id });
      expect(correction).toHaveLength(1);
      expect(correction[0]).toMatchObject({ signal: "positive", documentId: document.id });
    });

    const clearType = await app.request(`/api/documents/${document.id}/type`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ documentTypeId: null }),
    });
    const clearTypeBody = await clearType.json();
    expect(clearTypeBody.document).toMatchObject({ documentTypeId: null, documentTypeSource: null, documentTypeName: null });

    const missing = await app.request(`/api/documents/doc_0000000000000000/type`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ documentTypeId: null }),
    });
    expect(missing.status).toBe(404);
  });

  it("deleting a type clears it from its documents", async () => {
    const { app, signIn, services } = await createTestApp();
    const { cookie, userId } = await signIn();
    const { document } = await services.documentsService.upload({ userId, name: "a.txt", mimeType: "text/plain", body: (await import("node:stream")).Readable.from(["a"]) });
    const type = (
      await (await app.request("/api/types", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Quote" }) })).json()
    ).type;
    await app.request(`/api/documents/${document.id}/type`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ documentTypeId: type.id }),
    });

    expect((await app.request(`/api/types/${type.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(204);

    const list = await (await app.request("/api/documents", { headers: { cookie } })).json();
    const row = list.documents.find((d: { id: string }) => d.id === document.id);
    expect(row).toMatchObject({ documentTypeId: null, documentTypeName: null });
  });
});
