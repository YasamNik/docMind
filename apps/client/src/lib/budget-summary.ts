import type { BudgetCategory, BudgetReceiptWithItems } from "./budget-api";

// The month endpoint returns every receipt with its items and nothing aggregated, so this
// is where "where did the money go" gets summed, on the client, once per render.

// Matches the server's RECONCILE_TOLERANCE (budget.models.ts): a receipt this close to
// reconciling is ordinary rounding, not something worth flagging as a mismatch again here.
const RECONCILE_TOLERANCE = 0.02;

function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export function itemsTotalFor(receipt: { items: { amount: number }[] }): number {
  return roundMoney(receipt.items.reduce((sum, item) => sum + item.amount, 0));
}

// The gap between what was printed and what the lines add up to: discounts, loyalty
// points, and bottle deposits are the normal case, not an error, so this only reports a
// gap worth a human's attention. Null once the receipt has no total to compare against
// yet, for example while it is still pending.
export function reconciliationGap(receipt: { total: number | null; items: { amount: number }[] }): number | null {
  if (receipt.total === null) return null;
  const gap = roundMoney(receipt.total - itemsTotalFor(receipt));
  return Math.abs(gap) > RECONCILE_TOLERANCE ? gap : null;
}

export function sumReceiptTotalsByCurrency(receipts: BudgetReceiptWithItems[]): { currency: string; total: number }[] {
  const totals = new Map<string, number>();
  for (const r of receipts) {
    if (r.currency === null || r.total === null) continue;
    totals.set(r.currency, roundMoney((totals.get(r.currency) ?? 0) + r.total));
  }
  return [...totals.entries()].map(([currency, total]) => ({ currency, total })).sort((a, b) => b.total - a.total);
}

export type CategorySpend = {
  categoryId: string | null; // null is the Unmatched row
  name: string;
  color: string | null;
  amount: number;
  share: number; // amount / the currency group's total, 0 when the group totals to 0
};

export type CurrencyBreakdown = {
  currency: string;
  total: number;
  categories: CategorySpend[];
};

const UNMATCHED_NAME = "Unmatched";

// Groups every line item by its receipt's currency and by category, and folds an
// uncategorised item's amount, and the reconciliation gap on any receipt whose items do
// not sum to its printed total, into one Unmatched row per currency rather than letting
// either quietly disappear from the picture (spec section 4). Almost every month has one
// currency, in which case this returns a single group; a mixed month never adds two
// currencies' amounts together into one meaningless number.
export function categoryBreakdownsByCurrency(receipts: BudgetReceiptWithItems[], categories: BudgetCategory[]): CurrencyBreakdown[] {
  const categoryById = new Map(categories.map((c) => [c.id, c] as const));
  const byCurrency = new Map<string, Map<string | null, number>>();

  for (const receipt of receipts) {
    if (!receipt.currency) continue;
    const bucket = byCurrency.get(receipt.currency) ?? new Map<string | null, number>();
    byCurrency.set(receipt.currency, bucket);

    for (const item of receipt.items) {
      bucket.set(item.categoryId, roundMoney((bucket.get(item.categoryId) ?? 0) + item.amount));
    }
    const gap = reconciliationGap(receipt);
    if (gap !== null) bucket.set(null, roundMoney((bucket.get(null) ?? 0) + gap));
  }

  const result: CurrencyBreakdown[] = [];
  for (const [currency, bucket] of byCurrency) {
    const named: { categoryId: string; name: string; color: string | null; amount: number }[] = [];
    let unmatched = 0;
    for (const [categoryId, amount] of bucket) {
      if (categoryId === null) {
        unmatched += amount;
        continue;
      }
      const category = categoryById.get(categoryId);
      named.push({ categoryId, name: category?.name ?? "Unknown category", color: category?.color ?? null, amount });
    }
    named.sort((a, b) => b.amount - a.amount);

    const groupTotal = roundMoney(named.reduce((sum, c) => sum + c.amount, 0) + unmatched);
    const share = (amount: number) => (groupTotal !== 0 ? Math.max(0, amount / groupTotal) : 0);

    const categoryRows: CategorySpend[] = named.map((c) => ({ ...c, share: share(c.amount) }));
    if (unmatched !== 0) {
      categoryRows.push({ categoryId: null, name: UNMATCHED_NAME, color: null, amount: roundMoney(unmatched), share: share(unmatched) });
    }

    result.push({ currency, total: groupTotal, categories: categoryRows });
  }
  return result.sort((a, b) => b.total - a.total);
}

export type CategoryFilter = { currency: string; categoryId: string | null };

// What "tapping a category filters the receipts below" means: the same currency, and
// either a line in that category, or, for Unmatched, an uncategorised line or a receipt
// whose lines do not reconcile with its printed total.
export function receiptMatchesCategoryFilter(receipt: BudgetReceiptWithItems, filter: CategoryFilter): boolean {
  if (receipt.currency !== filter.currency) return false;
  if (filter.categoryId === null) {
    return receipt.items.some((item) => item.categoryId === null) || reconciliationGap(receipt) !== null;
  }
  return receipt.items.some((item) => item.categoryId === filter.categoryId);
}

// Well-formed but unrecognised codes (spec: currency is stored as printed, never
// validated against a real list) still render through Intl, just without a familiar
// symbol. Only a malformed code falls back to a plain number.
export function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null || currency === null) return "-";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
