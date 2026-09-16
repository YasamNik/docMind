import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

afterEach(() => vi.restoreAllMocks());

describe("api client", () => {
  it("returns parsed JSON on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    expect(await api.get<{ ok: number }>("/api/health")).toEqual({ ok: 1 });
  });

  it("throws ApiError with the server code on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "documents.not_found", message: "nope" } }), { status: 404 }),
    );
    await expect(api.get("/api/documents/doc_x")).rejects.toMatchObject({ code: "documents.not_found", status: 404 } satisfies Partial<ApiError>);
  });
});
