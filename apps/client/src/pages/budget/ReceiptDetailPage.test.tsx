import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReceiptDetailPage } from "./ReceiptDetailPage";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const groceries = { id: "bcat_groceries", name: "Groceries", description: "Food", color: "#4f46e5", autoApply: 1, createdAt: "", updatedAt: "" };
const household = { id: "bcat_household", name: "Household", description: "Home", color: "#22c55e", autoApply: 1, createdAt: "", updatedAt: "" };

function baseReceipt(overrides: Record<string, unknown> = {}) {
  return {
    id: "brcpt_1",
    documentId: "doc_1",
    merchant: "Corner shop",
    categoryId: "bcat_groceries",
    purchasedAt: "2026-09-10",
    currency: "USD",
    total: 25,
    taxAmount: null,
    status: "ready",
    note: null,
    duplicateOfReceiptId: null,
    createdAt: "2026-09-10T12:00:00.000Z",
    updatedAt: "2026-09-10T12:00:00.000Z",
    items: [
      { id: "britem_1", receiptId: "brcpt_1", lineNumber: 1, description: "Milk", quantity: 1, unitPrice: 20, amount: 20, categoryId: "bcat_groceries", categorySource: "auto", confidence: 0.9, createdAt: "", updatedAt: "" },
      { id: "britem_2", receiptId: "brcpt_1", lineNumber: 2, description: "Mystery item", quantity: null, unitPrice: null, amount: 5, categoryId: null, categorySource: null, confidence: null, createdAt: "", updatedAt: "" },
    ],
    ...overrides,
  };
}

const getReceiptMock = vi.fn(async (_id: string) => baseReceipt());
const listCategoriesMock = vi.fn(async () => [groceries, household]);
const updateReceiptMock = vi.fn();
const updateItemCategoryMock = vi.fn();
const resolveDuplicateMock = vi.fn();

vi.mock("@/lib/budget-api", () => ({
  budgetApi: {
    getReceipt: (id: string) => getReceiptMock(id),
    listCategories: () => listCategoriesMock(),
    updateReceipt: (id: string, patch: unknown) => updateReceiptMock(id, patch),
    updateItemCategory: (receiptId: string, itemId: string, categoryId: string | null) => updateItemCategoryMock(receiptId, itemId, categoryId),
    resolveDuplicate: (receiptId: string, action: string) => resolveDuplicateMock(receiptId, action),
  },
}));

function renderPage(id = "brcpt_1", queryClient = new QueryClient()) {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/budget/receipts/${id}`]}>
        <Routes>
          <Route path="/budget/receipts/:id" element={<ReceiptDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("ReceiptDetailPage", () => {
  it("shows the merchant, date, and total", async () => {
    renderPage();
    expect(await screen.findByText("Corner shop")).toBeInTheDocument();
    expect(screen.getByText("Sep 10, 2026 · $25.00")).toBeInTheDocument();
  });

  it("shows every line with its description and category", async () => {
    renderPage();
    expect(await screen.findByText("Milk")).toBeInTheDocument();
    expect(screen.getByText("Mystery item")).toBeInTheDocument();
  });

  it("shows a line the model was unsure of as uncategorised rather than guessed", async () => {
    renderPage();
    await screen.findByText("Mystery item");
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    const itemSelect = selects.find((s) => s.value === "");
    expect(itemSelect).toBeDefined();
  });

  it("lets a line's category be corrected", async () => {
    updateItemCategoryMock.mockResolvedValueOnce({ receipt: baseReceipt() });
    renderPage();
    await screen.findByText("Mystery item");
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    const itemSelect = selects.find((s) => s.value === "")!;
    fireEvent.change(itemSelect, { target: { value: "bcat_household" } });
    await waitFor(() => expect(updateItemCategoryMock).toHaveBeenCalledWith("brcpt_1", "britem_2", "bcat_household"));
  });

  it("edits the receipt's own fields", async () => {
    updateReceiptMock.mockResolvedValueOnce(baseReceipt({ merchant: "Corner shop and deli" }));
    renderPage();
    fireEvent.click(await screen.findByText("Edit"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Merchant"), { target: { value: "Corner shop and deli" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateReceiptMock).toHaveBeenCalledWith(
        "brcpt_1",
        expect.objectContaining({ merchant: "Corner shop and deli" }),
      ),
    );
  });

  // A wrong date is a normal thing a person corrects. The fix has to move the receipt
  // into its right month, not just update the field: invalidating the receipts list
  // query is what makes the Budget page's month view pick up the change.
  it("moves the receipt into its corrected month by invalidating the receipts list, not just the receipt itself", async () => {
    updateReceiptMock.mockResolvedValueOnce(baseReceipt({ purchasedAt: "2026-10-01" }));
    const queryClient = renderPage("brcpt_1");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    fireEvent.click(await screen.findByText("Edit"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Date"), { target: { value: "2026-10-01" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateReceiptMock).toHaveBeenCalledWith("brcpt_1", expect.objectContaining({ purchasedAt: "2026-10-01" })),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["budget", "receipts"] });
  });

  it("says a receipt failed to read, and why", async () => {
    getReceiptMock.mockResolvedValueOnce(
      baseReceipt({ status: "failed", note: "The model could not read a receipt from these photos.", merchant: null, total: null, currency: null, items: [] }),
    );
    renderPage();
    expect(await screen.findByText("Could not read this receipt")).toBeInTheDocument();
    expect(screen.getByText("The model could not read a receipt from these photos.")).toBeInTheDocument();
  });

  it("flags a possible duplicate plainly, with the matched receipt, and offers to resolve it", async () => {
    getReceiptMock.mockImplementation(async (id: string) => {
      if (id === "brcpt_1") return baseReceipt({ duplicateOfReceiptId: "brcpt_2", status: "needs_review" });
      return baseReceipt({ id: "brcpt_2", merchant: "Corner shop" });
    });
    resolveDuplicateMock.mockResolvedValueOnce({ receipt: baseReceipt({ duplicateOfReceiptId: null }) });

    renderPage();
    expect(await screen.findByText("Possible duplicate")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep both" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete this one" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Keep both" }));
    await waitFor(() => expect(resolveDuplicateMock).toHaveBeenCalledWith("brcpt_1", "keep"));
  });

  it("confirms before deleting a flagged duplicate", async () => {
    getReceiptMock.mockImplementation(async (id: string) => {
      if (id === "brcpt_1") return baseReceipt({ duplicateOfReceiptId: "brcpt_2", status: "needs_review" });
      return baseReceipt({ id: "brcpt_2" });
    });
    resolveDuplicateMock.mockResolvedValueOnce({ deleted: true });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Delete this one" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(resolveDuplicateMock).toHaveBeenCalledWith("brcpt_1", "delete"));
  });

  it("shows a receipt still being read as pending", async () => {
    getReceiptMock.mockResolvedValueOnce(baseReceipt({ status: "pending", merchant: null, total: null, currency: null, items: [] }));
    renderPage();
    expect(await screen.findByText("Reading receipt...")).toBeInTheDocument();
  });

  it("surfaces the update error through a toast", async () => {
    updateItemCategoryMock.mockRejectedValueOnce(new Error("Budget category not found"));
    renderPage();
    await screen.findByText("Mystery item");
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    const itemSelect = selects.find((s) => s.value === "")!;
    fireEvent.change(itemSelect, { target: { value: "bcat_household" } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Budget category not found"));
  });
});
