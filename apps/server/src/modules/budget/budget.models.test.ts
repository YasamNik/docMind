import { describe, expect, it } from "vitest";
import {
  assembleReceiptPrompt,
  BUDGET_CATEGORY_PRESETS,
  itemsReconcileWithTotal,
  newBudgetCategoryId,
  newBudgetReceiptId,
  newBudgetReceiptItemId,
  normalizeReceiptItemRows,
  normalizeReceiptReply,
  nowIso,
  sumItemAmounts,
} from "./budget.models.js";

const groceries = { id: "bcat_groceries0000", name: "Groceries" };
const appliances = { id: "bcat_appliances000", name: "Appliances" };
const categories = [groceries, appliances];

describe("budget models", () => {
  it("makes prefixed ids", () => {
    expect(newBudgetReceiptId()).toMatch(/^brcpt_[0-9a-f]{16}$/);
    expect(newBudgetReceiptItemId()).toMatch(/^britem_[0-9a-f]{16}$/);
    expect(newBudgetCategoryId()).toMatch(/^bcat_[0-9a-f]{16}$/);
    expect(newBudgetReceiptId()).not.toBe(newBudgetReceiptId());
  });

  it("makes an ISO timestamp", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  describe("BUDGET_CATEGORY_PRESETS", () => {
    it("lists twenty presets, each with a unique name and a non-empty description", () => {
      expect(BUDGET_CATEGORY_PRESETS).toHaveLength(20);
      const names = BUDGET_CATEGORY_PRESETS.map((p) => p.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toContain("Groceries");
      for (const preset of BUDGET_CATEGORY_PRESETS) {
        expect(preset.description.trim().length).toBeGreaterThan(0);
      }
    });

    it("has an Other preset, so a receipt or line that matches nothing still lands somewhere sortable", () => {
      expect(BUDGET_CATEGORY_PRESETS.map((p) => p.name)).toContain("Other");
    });

    it("covers a receipt-level kind like Entertainment and an item-level kind like Produce, since one vocabulary serves both", () => {
      const names = BUDGET_CATEGORY_PRESETS.map((p) => p.name);
      expect(names).toContain("Entertainment");
      expect(names).toContain("Produce");
    });
  });

  describe("normalizeReceiptItemRows", () => {
    it("drops a row with no amount but keeps the good rows", () => {
      const { items, droppedCount } = normalizeReceiptItemRows(
        [
          { description: "Bread", amount: 2.5 },
          { description: "Missing amount item" },
          { description: "Milk", amount: 1.2 },
        ],
        categories,
      );
      expect(items.map((i) => i.description)).toEqual(["Bread", "Milk"]);
      expect(droppedCount).toBe(1);
    });

    it("drops a bare string or null in the items array instead of failing", () => {
      const { items, droppedCount } = normalizeReceiptItemRows(["a bare string", null, { description: "Bread", amount: 2.5 }], categories);
      expect(items.map((i) => i.description)).toEqual(["Bread"]);
      expect(droppedCount).toBe(2);
    });

    it("returns no items when the reply's items value is not an array", () => {
      expect(normalizeReceiptItemRows("none", categories)).toEqual({ items: [], droppedCount: 0 });
    });

    it("matches a category name case-insensitively when confidence clears the floor", () => {
      const { items } = normalizeReceiptItemRows([{ description: "Kettle", amount: 20, category: "appliances", categoryConfidence: 0.8 }], categories);
      expect(items[0]).toMatchObject({ categoryId: appliances.id, categorySource: "auto", confidence: 0.8 });
    });

    it("drops a category name that is not in the vocabulary but keeps the item", () => {
      const { items } = normalizeReceiptItemRows([{ description: "Mystery item", amount: 5, category: "Not A Real Category", categoryConfidence: 0.9 }], categories);
      expect(items).toHaveLength(1);
      expect(items[0]!.categoryId).toBeNull();
      expect(items[0]!.categorySource).toBeNull();
    });

    it("leaves a low-confidence category unset rather than guessing", () => {
      const { items } = normalizeReceiptItemRows([{ description: "Bread", amount: 2.5, category: "Groceries", categoryConfidence: 0.4 }], categories);
      expect(items[0]!.categoryId).toBeNull();
      expect(items[0]!.confidence).toBeNull();
    });
  });

  describe("sumItemAmounts and itemsReconcileWithTotal", () => {
    it("sums item amounts to the cent", () => {
      expect(sumItemAmounts([{ amount: 1.1 }, { amount: 2.2 }, { amount: 3.3 }])).toBeCloseTo(6.6, 2);
    });

    it("reconciles within the 0.02 tolerance", () => {
      expect(itemsReconcileWithTotal(9.99, 10.0)).toBe(true);
      expect(itemsReconcileWithTotal(9.97, 10.0)).toBe(false);
    });
  });

  describe("normalizeReceiptReply", () => {
    it("marks the reply failed when every header field is null", () => {
      const result = normalizeReceiptReply({ reply: { merchant: null, purchasedAt: null, currency: null, total: null }, categories });
      expect(result.failed).toBe(true);
      if (result.failed) expect(result.note).toBe("The model could not read a receipt from these photos.");
    });

    it("uses the model's warning as the failure note when the header is all null", () => {
      const result = normalizeReceiptReply({
        reply: { merchant: null, purchasedAt: null, currency: null, total: null, warning: "Clearly two different receipts" },
        categories,
      });
      expect(result.failed).toBe(true);
      if (result.failed) expect(result.note).toBe("Clearly two different receipts");
    });

    it("forces needs_review and copies a non-empty warning into the note, even with a readable header", () => {
      const result = normalizeReceiptReply({
        reply: {
          merchant: "Corner Shop",
          purchasedAt: "2026-09-10",
          currency: "USD",
          total: 5,
          warning: "One photo was blurry",
          items: [{ description: "Bread", amount: 5 }],
        },
        categories,
      });
      expect(result.failed).toBe(false);
      if (!result.failed) {
        expect(result.status).toBe("needs_review");
        expect(result.note).toContain("One photo was blurry");
      }
    });

    it("flags needs_review when the items do not sum to the printed total beyond tolerance", () => {
      const result = normalizeReceiptReply({
        reply: {
          merchant: "Corner Shop",
          purchasedAt: "2026-09-10",
          currency: "USD",
          total: 10,
          items: [{ description: "Bread", amount: 2.5 }, { description: "Milk", amount: 2.5 }],
        },
        categories,
      });
      expect(result.failed).toBe(false);
      if (!result.failed) {
        expect(result.status).toBe("needs_review");
        expect(result.note).toContain("does not match the printed total");
      }
    });

    it("does not flag review for a 0.01 rounding difference", () => {
      const result = normalizeReceiptReply({
        reply: {
          merchant: "Corner Shop",
          purchasedAt: "2026-09-10",
          currency: "USD",
          total: 5.0,
          items: [{ description: "Bread", amount: 2.5 }, { description: "Milk", amount: 2.49 }],
        },
        categories,
      });
      expect(result.failed).toBe(false);
      if (!result.failed) {
        expect(result.status).toBe("ready");
        expect(result.note).toBeNull();
      }
    });

    it("is ready with no note when the header reads cleanly and items reconcile", () => {
      const result = normalizeReceiptReply({
        reply: {
          merchant: "Corner Shop",
          purchasedAt: "2026-09-10",
          currency: "usd",
          total: 5,
          category: "Groceries",
          categoryConfidence: 0.9,
          items: [{ description: "Bread", amount: 5, category: "Groceries", categoryConfidence: 0.9 }],
        },
        categories,
      });
      expect(result.failed).toBe(false);
      if (!result.failed) {
        expect(result.status).toBe("ready");
        expect(result.note).toBeNull();
        expect(result.currency).toBe("USD");
        expect(result.categoryId).toBe(groceries.id);
        expect(result.items[0]!.categoryId).toBe(groceries.id);
      }
    });

    it("keeps a readable header when the items array itself is malformed", () => {
      const result = normalizeReceiptReply({
        reply: { merchant: "Corner Shop", purchasedAt: "2026-09-10", currency: "USD", total: 5, items: "none" },
        categories,
      });
      expect(result.failed).toBe(false);
      if (!result.failed) {
        expect(result.merchant).toBe("Corner Shop");
        expect(result.items).toEqual([]);
      }
    });
  });

  describe("assembleReceiptPrompt", () => {
    it("lists every automatic category by name and description", () => {
      const { system } = assembleReceiptPrompt({ categories: [{ name: "Groceries", description: "Food for the home." }] });
      expect(system).toContain("Groceries: Food for the home.");
    });

    it("tells the model not to double count an overlapping line across two photos", () => {
      const { system } = assembleReceiptPrompt({ categories: [] });
      expect(system.toLowerCase()).toContain("exactly once");
    });
  });
});
