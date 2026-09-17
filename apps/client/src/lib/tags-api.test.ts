import { afterEach, describe, expect, it, vi } from "vitest";
import { categoriesApi, documentCategorizationApi, tagsApi } from "./tags-api";

afterEach(() => vi.restoreAllMocks());

describe("tagsApi", () => {
  it("lists, creates, updates, and removes a tag", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ tags: [{ id: "tag_1", name: "Rent" }] }), { status: 200 }));
    expect(await tagsApi.list()).toEqual([{ id: "tag_1", name: "Rent" }]);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ tag: { id: "tag_2", name: "Bills" } }), { status: 201 }));
    expect(await tagsApi.create({ name: "Bills" })).toEqual({ id: "tag_2", name: "Bills" });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ tag: { id: "tag_2", name: "Utilities" } }), { status: 200 }));
    expect(await tagsApi.update("tag_2", { name: "Utilities" })).toEqual({ id: "tag_2", name: "Utilities" });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 204 }));
    await tagsApi.remove("tag_2");
  });
});

describe("categoriesApi", () => {
  it("lists and creates a category", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ categories: [] }), { status: 200 }));
    expect(await categoriesApi.list()).toEqual([]);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ category: { id: "cat_1", name: "Finance" } }), { status: 201 }));
    expect(await categoriesApi.create({ name: "Finance" })).toEqual({ id: "cat_1", name: "Finance" });
  });
});

describe("documentCategorizationApi", () => {
  it("sets a category and adds and removes a tag", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ document: { id: "doc_1", categoryId: "cat_1" } }), { status: 200 }));
    expect(await documentCategorizationApi.setCategory("doc_1", "cat_1")).toEqual({ id: "doc_1", categoryId: "cat_1" });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ tags: [{ id: "tag_1", name: "Rent", color: null, auto: false, manual: true }] }), { status: 200 }),
    );
    expect(await documentCategorizationApi.addTag("doc_1", "tag_1")).toEqual([{ id: "tag_1", name: "Rent", color: null, auto: false, manual: true }]);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ tags: [] }), { status: 200 }));
    expect(await documentCategorizationApi.removeTag("doc_1", "tag_1")).toEqual([]);
  });
});
