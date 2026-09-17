import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { CategoryRow } from "@/lib/tags-api";
import { CategoryTreeNav } from "./CategoryTreeNav";

afterEach(() => cleanup());

function category(overrides: Partial<CategoryRow>): CategoryRow {
  return {
    id: "cat_x",
    name: "Category",
    parentId: null,
    color: null,
    description: "",
    confidenceThreshold: 0.7,
    autoApply: true,
    sortOrder: 0,
    path: "Category",
    documentCount: 0,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("CategoryTreeNav", () => {
  it("renders a nested tree with recursive document counts", () => {
    const categories = [
      category({ id: "cat_1", name: "Finance", documentCount: 2 }),
      category({ id: "cat_2", name: "Tax", parentId: "cat_1", documentCount: 1, path: "Finance / Tax" }),
    ];
    render(
      <MemoryRouter>
        <CategoryTreeNav categories={categories} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Finance")).toBeInTheDocument();
    expect(screen.getByText("Tax")).toBeInTheDocument();
    // Finance shows 3 (its own 2 plus Tax's 1); Tax shows 1 (leaf, direct only).
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("shows a placeholder when there are no categories", () => {
    render(
      <MemoryRouter>
        <CategoryTreeNav categories={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByText("No categories yet.")).toBeInTheDocument();
  });
});
