import { describe, expect, it } from "vitest";
import type { BudgetCategory, BudgetReceiptWithItems } from "./budget-api";
import {
  categoryBreakdownsByCurrency,
  formatMoney,
  itemsTotalFor,
  receiptMatchesCategoryFilter,
  reconciliationGap,
  sumReceiptTotalsByCurrency,
} from "./budget-summary";

function receipt(overrides: Partial<BudgetReceiptWithItems>): BudgetReceiptWithItems {
  return {
    id: "brcpt_1",
    documentId: "doc_1",
    merchant: "Corner shop",
    categoryId: null,
    purchasedAt: "2026-09-10",
    currency: "USD",
    total: 10,
    taxAmount: null,
    status: "ready",
    note: null,
    duplicateOfReceiptId: null,
    createdAt: "2026-09-10T12:00:00.000Z",
    updatedAt: "2026-09-10T12:00:00.000Z",
    items: [],
    ...overrides,
  };
}

function item(overrides: Partial<BudgetReceiptWithItems["items"][number]>) {
  return {
    id: "britem_1",
    receiptId: "brcpt_1",
    lineNumber: 1,
    description: "Milk",
    quantity: null,
    unitPrice: null,
    amount: 5,
    categoryId: null,
    categorySource: null,
    confidence: null,
    createdAt: "2026-09-10T12:00:00.000Z",
    updatedAt: "2026-09-10T12:00:00.000Z",
    ...overrides,
  };
}

const groceries: BudgetCategory = {
  id: "bcat_groceries",
  name: "Groceries",
  description: "Food",
  color: "#4f46e5",
  autoApply: 1,
  createdAt: "",
  updatedAt: "",
};
const household: BudgetCategory = {
  id: "bcat_household",
  name: "Household",
  description: "Home",
  color: "#22c55e",
  autoApply: 1,
  createdAt: "",
  updatedAt: "",
};

describe("sumReceiptTotalsByCurrency", () => {
  it("sums receipt totals per currency, biggest first", () => {
    const receipts = [
      receipt({ currency: "USD", total: 10 }),
      receipt({ currency: "EUR", total: 50 }),
      receipt({ currency: "USD", total: 20 }),
    ];
    expect(sumReceiptTotalsByCurrency(receipts)).toEqual([
      { currency: "EUR", total: 50 },
      { currency: "USD", total: 30 },
    ]);
  });

  it("ignores a receipt with no total or no currency yet", () => {
    const receipts = [receipt({ currency: null, total: null, status: "pending" }), receipt({ currency: "USD", total: 10 })];
    expect(sumReceiptTotalsByCurrency(receipts)).toEqual([{ currency: "USD", total: 10 }]);
  });
});

describe("categoryBreakdownsByCurrency", () => {
  it("groups item amounts by category, biggest first", () => {
    const receipts = [
      receipt({
        currency: "USD",
        total: 15,
        items: [item({ amount: 10, categoryId: "bcat_groceries" }), item({ amount: 5, categoryId: "bcat_household" })],
      }),
    ];
    const [usd] = categoryBreakdownsByCurrency(receipts, [groceries, household]);
    expect(usd!.currency).toBe("USD");
    expect(usd!.categories.map((c) => c.name)).toEqual(["Groceries", "Household"]);
    expect(usd!.categories[0]!.amount).toBe(10);
  });

  it("puts an uncategorised item's amount into Unmatched, last regardless of size", () => {
    const receipts = [
      receipt({
        currency: "USD",
        total: 20,
        items: [item({ amount: 5, categoryId: "bcat_household" }), item({ amount: 15, categoryId: null })],
      }),
    ];
    const [usd] = categoryBreakdownsByCurrency(receipts, [groceries, household]);
    expect(usd!.categories.map((c) => c.name)).toEqual(["Household", "Unmatched"]);
    expect(usd!.categories.at(-1)).toMatchObject({ categoryId: null, amount: 15 });
  });

  it("adds the gap between the printed total and the items' sum into Unmatched", () => {
    // A discount or a bottle deposit not itemised: the printed total is higher than what
    // the lines add up to, so the difference should not just vanish from the breakdown.
    const receipts = [
      receipt({
        currency: "USD",
        total: 12,
        items: [item({ amount: 10, categoryId: "bcat_groceries" })],
      }),
    ];
    const [usd] = categoryBreakdownsByCurrency(receipts, [groceries]);
    expect(usd!.categories.map((c) => c.name)).toEqual(["Groceries", "Unmatched"]);
    expect(usd!.categories.at(-1)).toMatchObject({ categoryId: null, amount: 2 });
  });

  it("keeps each currency's spend in its own group", () => {
    const receipts = [
      receipt({ currency: "USD", total: 10, items: [item({ amount: 10, categoryId: "bcat_groceries" })] }),
      receipt({ currency: "EUR", total: 5, items: [item({ amount: 5, categoryId: "bcat_household" })] }),
    ];
    const breakdowns = categoryBreakdownsByCurrency(receipts, [groceries, household]);
    expect(breakdowns.map((b) => b.currency).sort()).toEqual(["EUR", "USD"]);
    const eur = breakdowns.find((b) => b.currency === "EUR")!;
    expect(eur.categories).toEqual([expect.objectContaining({ name: "Household", amount: 5 })]);
  });
});

describe("itemsTotalFor and reconciliationGap", () => {
  it("sums item amounts", () => {
    expect(itemsTotalFor({ items: [item({ amount: 1.1 }), item({ amount: 2.2 })] })).toBeCloseTo(3.3);
  });

  it("reports no gap within the rounding tolerance", () => {
    expect(reconciliationGap({ total: 10, items: [item({ amount: 9.99 })] })).toBeNull();
  });

  it("reports the signed gap past the tolerance", () => {
    expect(reconciliationGap({ total: 10, items: [item({ amount: 8 })] })).toBe(2);
  });

  it("returns null when the receipt has no total yet", () => {
    expect(reconciliationGap({ total: null, items: [item({ amount: 8 })] })).toBeNull();
  });
});

describe("receiptMatchesCategoryFilter", () => {
  it("matches a receipt with a line in the filtered category", () => {
    const r = receipt({ currency: "USD", items: [item({ categoryId: "bcat_groceries" })] });
    expect(receiptMatchesCategoryFilter(r, { currency: "USD", categoryId: "bcat_groceries" })).toBe(true);
    expect(receiptMatchesCategoryFilter(r, { currency: "USD", categoryId: "bcat_household" })).toBe(false);
  });

  it("never matches a receipt in a different currency", () => {
    const r = receipt({ currency: "EUR", items: [item({ categoryId: "bcat_groceries" })] });
    expect(receiptMatchesCategoryFilter(r, { currency: "USD", categoryId: "bcat_groceries" })).toBe(false);
  });

  it("matches Unmatched for an uncategorised line", () => {
    const r = receipt({ currency: "USD", total: 5, items: [item({ amount: 5, categoryId: null })] });
    expect(receiptMatchesCategoryFilter(r, { currency: "USD", categoryId: null })).toBe(true);
  });

  it("matches Unmatched for a receipt whose items do not reconcile with the total", () => {
    const r = receipt({ currency: "USD", total: 20, items: [item({ amount: 10, categoryId: "bcat_groceries" })] });
    expect(receiptMatchesCategoryFilter(r, { currency: "USD", categoryId: null })).toBe(true);
  });

  it("does not match Unmatched for a fully categorised, reconciled receipt", () => {
    const r = receipt({ currency: "USD", total: 10, items: [item({ amount: 10, categoryId: "bcat_groceries" })] });
    expect(receiptMatchesCategoryFilter(r, { currency: "USD", categoryId: null })).toBe(false);
  });
});

describe("formatMoney", () => {
  it("formats an amount with its currency", () => {
    expect(formatMoney(12.5, "USD")).toBe("$12.50");
  });

  it("still renders an unrecognised but well-formed currency code", () => {
    // Intl separates an unrecognised code from the amount with a non-breaking space.
    expect(formatMoney(12.5, "ZZZ")).toBe("ZZZ 12.50");
  });

  it("falls back to a plain number and code for a malformed currency", () => {
    expect(formatMoney(12.5, "US")).toBe("12.50 US");
  });

  it("shows a dash when the amount or currency is not known yet", () => {
    expect(formatMoney(null, "USD")).toBe("-");
    expect(formatMoney(12.5, null)).toBe("-");
  });
});
