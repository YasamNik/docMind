import { describe, expect, it } from "vitest";
import { BUDGET_CATEGORY_PRESETS, newBudgetCategoryId, newBudgetReceiptId, newBudgetReceiptItemId, nowIso } from "./budget.models.js";

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
});
