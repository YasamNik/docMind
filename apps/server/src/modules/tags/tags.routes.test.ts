import { describe, expect, it } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";

describe("tags and categories routes", () => {
  it("requires a session on every route", async () => {
    const { app } = await createTestApp();
    expect((await app.request("/api/tags")).status).toBe(401);
    expect((await app.request("/api/categories")).status).toBe(401);
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
    expect((await setCategory.json()).document).toMatchObject({ categoryId: category.id, categorySource: "manual" });

    const addTag = await app.request(`/api/documents/${document.id}/tags/${tag.id}`, { method: "POST", headers: { cookie } });
    expect((await addTag.json()).tags).toEqual([{ id: tag.id, name: "Rent", color: null, auto: false, manual: true }]);

    const removeTag = await app.request(`/api/documents/${document.id}/tags/${tag.id}`, { method: "DELETE", headers: { cookie } });
    expect((await removeTag.json()).tags).toEqual([]);

    const clearCategory = await app.request(`/api/documents/${document.id}/category`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ categoryId: null }),
    });
    expect((await clearCategory.json()).document).toMatchObject({ categoryId: null, categorySource: null });

    const missing = await app.request(`/api/documents/doc_0000000000000000/category`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ categoryId: null }),
    });
    expect(missing.status).toBe(404);
  });
});
