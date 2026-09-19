import { afterEach, describe, expect, it, vi } from "vitest";
import { documentTypeApi, typesApi } from "./types-api";

afterEach(() => vi.restoreAllMocks());

describe("typesApi", () => {
  it("lists, creates, updates, and removes a type", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ types: [{ id: "dtype_1", name: "Invoice" }] }), { status: 200 }));
    expect(await typesApi.list()).toEqual([{ id: "dtype_1", name: "Invoice" }]);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ type: { id: "dtype_2", name: "Receipt" } }), { status: 201 }));
    expect(await typesApi.create({ name: "Receipt" })).toEqual({ id: "dtype_2", name: "Receipt" });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ type: { id: "dtype_2", name: "Receipts" } }), { status: 200 }));
    expect(await typesApi.update("dtype_2", { name: "Receipts" })).toEqual({ id: "dtype_2", name: "Receipts" });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 204 }));
    await typesApi.remove("dtype_2");
  });
});

describe("documentTypeApi", () => {
  it("sets the type on a document", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ document: { id: "doc_1", documentTypeId: "dtype_1" } }), { status: 200 }));
    expect(await documentTypeApi.setType("doc_1", "dtype_1")).toEqual({ id: "doc_1", documentTypeId: "dtype_1" });
  });

  it("clears the type on a document", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ document: { id: "doc_1", documentTypeId: null } }), { status: 200 }));
    expect(await documentTypeApi.setType("doc_1", null)).toEqual({ id: "doc_1", documentTypeId: null });
  });
});
