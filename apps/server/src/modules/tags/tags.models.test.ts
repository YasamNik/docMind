import { describe, expect, it } from "vitest";
import {
  buildCategoryPaths,
  collectDescendantIds,
  newCategoryId,
  newTagId,
  nextSortOrder,
  normalizeName,
  sortByNameCI,
  sortCategories,
  wouldCreateCycle,
} from "./tags.models.js";

type Node = { id: string; parentId: string | null; name: string };

describe("tags models", () => {
  it("makes prefixed ids", () => {
    expect(newTagId()).toMatch(/^tag_[0-9a-f]{16}$/);
    expect(newCategoryId()).toMatch(/^cat_[0-9a-f]{16}$/);
    expect(newTagId()).not.toBe(newTagId());
  });

  it("trims names", () => {
    expect(normalizeName("  Rent  ")).toBe("Rent");
    expect(normalizeName("Rent")).toBe("Rent");
  });

  describe("buildCategoryPaths", () => {
    const tree: Node[] = [
      { id: "cat_a", parentId: null, name: "Finance" },
      { id: "cat_b", parentId: "cat_a", name: "Tax" },
      { id: "cat_c", parentId: "cat_b", name: "Receipts" },
      { id: "cat_d", parentId: null, name: "Personal" },
    ];

    it("builds full paths from the root with the default separator", () => {
      const paths = buildCategoryPaths(tree);
      expect(paths.get("cat_a")).toBe("Finance");
      expect(paths.get("cat_b")).toBe("Finance / Tax");
      expect(paths.get("cat_c")).toBe("Finance / Tax / Receipts");
      expect(paths.get("cat_d")).toBe("Personal");
    });

    it("accepts a custom separator", () => {
      expect(buildCategoryPaths(tree, " > ").get("cat_c")).toBe("Finance > Tax > Receipts");
    });

    it("returns an empty map for an empty list", () => {
      expect(buildCategoryPaths([]).size).toBe(0);
    });
  });

  describe("collectDescendantIds", () => {
    const tree: Node[] = [
      { id: "cat_a", parentId: null, name: "Finance" },
      { id: "cat_b", parentId: "cat_a", name: "Tax" },
      { id: "cat_c", parentId: "cat_b", name: "Receipts" },
      { id: "cat_d", parentId: null, name: "Personal" },
    ];

    it("collects every descendant at any depth", () => {
      expect(collectDescendantIds(tree, "cat_a").sort()).toEqual(["cat_b", "cat_c"]);
      expect(collectDescendantIds(tree, "cat_b")).toEqual(["cat_c"]);
      expect(collectDescendantIds(tree, "cat_c")).toEqual([]);
      expect(collectDescendantIds(tree, "cat_d")).toEqual([]);
    });
  });

  describe("wouldCreateCycle", () => {
    const tree: Node[] = [
      { id: "cat_a", parentId: null, name: "Finance" },
      { id: "cat_b", parentId: "cat_a", name: "Tax" },
      { id: "cat_c", parentId: "cat_b", name: "Receipts" },
    ];

    it("rejects self-parenting", () => {
      expect(wouldCreateCycle(tree, "cat_a", "cat_a")).toBe(true);
    });

    it("rejects making a category a child of its own descendant", () => {
      expect(wouldCreateCycle(tree, "cat_a", "cat_c")).toBe(true);
      expect(wouldCreateCycle(tree, "cat_b", "cat_c")).toBe(true);
    });

    it("allows a valid move", () => {
      expect(wouldCreateCycle(tree, "cat_c", "cat_a")).toBe(false);
    });

    it("allows moving to the root", () => {
      expect(wouldCreateCycle(tree, "cat_c", null)).toBe(false);
    });
  });

  describe("nextSortOrder", () => {
    it("is 0 for the first sibling", () => {
      expect(nextSortOrder([])).toBe(0);
    });

    it("is one past the current maximum", () => {
      expect(nextSortOrder([0, 3, 1])).toBe(4);
    });
  });

  describe("sortByNameCI", () => {
    it("sorts case-insensitively", () => {
      const items = [{ name: "rent" }, { name: "Bills" }, { name: "Apartment" }];
      expect(sortByNameCI(items).map((i) => i.name)).toEqual(["Apartment", "Bills", "rent"]);
    });
  });

  describe("sortCategories", () => {
    it("sorts by sortOrder then name case-insensitively", () => {
      const items = [
        { name: "zzz", sortOrder: 1 },
        { name: "aaa", sortOrder: 1 },
        { name: "mmm", sortOrder: 0 },
      ];
      expect(sortCategories(items).map((i) => i.name)).toEqual(["mmm", "aaa", "zzz"]);
    });
  });
});
