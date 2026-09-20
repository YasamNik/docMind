import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { budgetApi } from "./budget-api";

afterEach(() => vi.restoreAllMocks());

describe("budgetApi.createReceipt", () => {
  it("returns the new receipt on 201", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ receipt: { id: "brcpt_1" } }), { status: 201 }));
    const result = await budgetApi.createReceipt(["doc_1", "doc_2"]);
    expect(result).toEqual({ receipt: { id: "brcpt_1" }, alreadyExisted: false });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/budget/receipts",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ documentIds: ["doc_1", "doc_2"] }) }),
    );
  });

  it("reads the existing receipt out of a 409 instead of throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ receipt: { id: "brcpt_existing" } }), { status: 409 }));
    const result = await budgetApi.createReceipt(["doc_1"]);
    expect(result).toEqual({ receipt: { id: "brcpt_existing" }, alreadyExisted: true });
  });

  it("throws an ApiError with the server's message on a genuine failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "budget.too_many_pages", message: "A receipt can have at most 10 pages, got 11." } }), { status: 400 }),
    );
    await expect(budgetApi.createReceipt(new Array(11).fill("doc_1"))).rejects.toEqual(
      new ApiError({ code: "budget.too_many_pages", message: "A receipt can have at most 10 pages, got 11.", status: 400 }),
    );
  });
});

describe("budgetApi other calls", () => {
  it("lists a month's receipts with the month in the query string", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ receipts: [] }), { status: 200 }));
    await budgetApi.listMonth("2026-09");
    expect(fetchSpy).toHaveBeenCalledWith("/api/budget/receipts?month=2026-09", expect.anything());
  });

  it("patches an item's category", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ receipt: { id: "brcpt_1" } }), { status: 200 }));
    await budgetApi.updateItemCategory("brcpt_1", "britem_1", "bcat_1");
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/budget/receipts/brcpt_1/items/britem_1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ categoryId: "bcat_1" }) }),
    );
  });
});
