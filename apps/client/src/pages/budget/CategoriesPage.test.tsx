import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { BudgetCategoriesPage } from "./CategoriesPage";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const listMock = vi.fn(async () => [
  { id: "bcat_1", name: "Groceries", description: "Everyday food and drink.", color: "#4f46e5", autoApply: 1, createdAt: "", updatedAt: "" },
  { id: "bcat_2", name: "Fuel", description: "", color: null, autoApply: 0, createdAt: "", updatedAt: "" },
]);
const createMock = vi.fn(async (input: unknown) => ({ id: "bcat_3", createdAt: "", updatedAt: "", ...(input as object) }));
const updateMock = vi.fn(async (id: string, patch: unknown) => ({ id, ...(patch as object) }));
const removeMock = vi.fn(async (_id: string) => undefined);

vi.mock("@/lib/budget-api", () => ({
  budgetApi: {
    listCategories: () => listMock(),
    createCategory: (input: unknown) => createMock(input),
    updateCategory: (id: string, patch: unknown) => updateMock(id, patch),
    removeCategory: (id: string) => removeMock(id),
  },
}));

function renderPage() {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <BudgetCategoriesPage />
    </QueryClientProvider>,
  );
}

describe("BudgetCategoriesPage", () => {
  it("lists existing categories", async () => {
    renderPage();
    expect(await screen.findByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Fuel")).toBeInTheDocument();
  });

  it("marks a category with no auto apply as manual only", async () => {
    renderPage();
    await screen.findByText("Fuel");
    expect(screen.getByText("Manual only")).toBeInTheDocument();
  });

  it("says the description is what the model reads when deciding", async () => {
    renderPage();
    expect(await screen.findByText(/text the model reads when deciding/i)).toBeInTheDocument();
  });

  it("shows the count of automatic categories that go into every receipt read", async () => {
    renderPage();
    // Only Groceries is both auto-apply and has a description; Fuel has neither.
    expect(await screen.findByText(/1 automatic category/i)).toBeInTheDocument();
  });

  it("creates a new category", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("New category"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Pharmacy" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ name: "Pharmacy" })));
  });

  it("edits a category", async () => {
    renderPage();
    fireEvent.click((await screen.findAllByText("Edit"))[0]!);
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Groceries and drink" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith("bcat_1", expect.objectContaining({ name: "Groceries and drink" })));
  });

  it("deletes a category after confirming", async () => {
    renderPage();
    fireEvent.click((await screen.findAllByText("Delete"))[0]!);
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("bcat_1"));
  });

  it("shows the server's error message when creating a duplicate name fails", async () => {
    createMock.mockRejectedValueOnce(new ApiError({ code: "budget.category_duplicate_name", message: "A budget category with this name already exists", status: 409 }));
    renderPage();
    fireEvent.click(await screen.findByText("New category"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Groceries" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("A budget category with this name already exists"));
  });
});
