import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BudgetReceiptWithItems } from "@/lib/budget-api";
import { BudgetPage } from "./BudgetPage";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  let counter = 0;
  window.URL.createObjectURL = vi.fn(() => `blob:mock-${counter++}`);
  window.URL.revokeObjectURL = vi.fn();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // @ts-expect-error test-only cleanup of a browser API jsdom does not implement by default
  delete window.matchMedia;
});

function mockMobileViewport() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === "(max-width: 767px)",
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const groceries = { id: "bcat_groceries", name: "Groceries", description: "Food", color: "#4f46e5", autoApply: 1, createdAt: "", updatedAt: "" };
const household = { id: "bcat_household", name: "Household", description: "Home", color: "#22c55e", autoApply: 1, createdAt: "", updatedAt: "" };

const readyReceipt: BudgetReceiptWithItems = {
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
    { id: "britem_2", receiptId: "brcpt_1", lineNumber: 2, description: "Sponge", quantity: 1, unitPrice: 5, amount: 5, categoryId: "bcat_household", categorySource: "auto", confidence: 0.8, createdAt: "", updatedAt: "" },
  ],
};

const pendingReceipt: BudgetReceiptWithItems = {
  ...readyReceipt,
  id: "brcpt_2",
  documentId: "doc_2",
  merchant: null,
  status: "pending",
  purchasedAt: null,
  total: null,
  currency: null,
  items: [],
};

const listMonthMock = vi.fn(async (_month: string) => ({ receipts: [readyReceipt], nearestMonthWithReceipts: null as string | null }));
const listCategoriesMock = vi.fn(async () => [groceries, household]);
const createReceiptMock = vi.fn();
const uploadMock = vi.fn();

vi.mock("@/lib/budget-api", () => ({
  MAX_RECEIPT_PAGES: 10,
  budgetApi: {
    listMonth: (month: string) => listMonthMock(month),
    listCategories: () => listCategoriesMock(),
    createReceipt: (documentIds: string[]) => createReceiptMock(documentIds),
  },
}));

vi.mock("@/lib/documents-api", () => ({
  documentsApi: { upload: (file: File, onProgress: (p: number) => void) => uploadMock(file, onProgress) },
}));

function ReceiptDetailStub() {
  const { id } = useParams();
  return <p>Receipt detail {id}</p>;
}

function renderPage() {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/budget"]}>
        <Routes>
          <Route path="/budget" element={<BudgetPage />} />
          <Route path="/budget/receipts/:id" element={<ReceiptDetailStub />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("BudgetPage", () => {
  it("shows the month total and the spend by category", async () => {
    renderPage();
    expect((await screen.findAllByText("$25.00")).length).toBeGreaterThan(0);
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Household")).toBeInTheDocument();
    expect(screen.getByText("$20.00")).toBeInTheDocument();
    expect(screen.getByText("$5.00")).toBeInTheDocument();
  });

  it("lists the month's receipts with the merchant and total", async () => {
    renderPage();
    expect(await screen.findByText("Corner shop")).toBeInTheDocument();
  });

  it("filters the receipt list when a category row is tapped", async () => {
    listMonthMock.mockResolvedValueOnce({
      receipts: [readyReceipt, { ...readyReceipt, id: "brcpt_3", merchant: "Hardware store", items: [readyReceipt.items[1]!] }],
      nearestMonthWithReceipts: null,
    });
    renderPage();
    await screen.findByText("Corner shop");
    expect(screen.getByText("Hardware store")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Groceries"));
    await waitFor(() => expect(screen.queryByText("Hardware store")).not.toBeInTheDocument());
    expect(screen.getByText("Corner shop")).toBeInTheDocument();
  });

  it("shows a receipt still being read as pending", async () => {
    listMonthMock.mockResolvedValueOnce({ receipts: [pendingReceipt], nearestMonthWithReceipts: null });
    renderPage();
    expect(await screen.findByText("Reading receipt...")).toBeInTheDocument();
  });

  it("switches month and refetches", async () => {
    renderPage();
    await screen.findByText("Corner shop");
    const monthInput = screen.getByLabelText("Month") as HTMLInputElement;
    fireEvent.change(monthInput, { target: { value: "2026-08" } });
    await waitFor(() => expect(listMonthMock).toHaveBeenCalledWith("2026-08"));
  });

  it("renders a card per receipt on a phone instead of a table", async () => {
    mockMobileViewport();
    renderPage();
    await screen.findByText("Corner shop");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders a table at a normal viewport", async () => {
    renderPage();
    await screen.findByText("Corner shop");
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  // The real bug: a receipt saved fine and read correctly, but the user never saw it
  // because Save dropped them back on a month that did not hold it. onCreated already
  // hands back the receipt; the page must use it to take the user straight there.
  it("takes the user to the new receipt once the capture sheet creates it", async () => {
    uploadMock.mockResolvedValueOnce({ document: { id: "doc_new" } });
    createReceiptMock.mockResolvedValueOnce({ receipt: { id: "brcpt_new" }, alreadyExisted: false });
    renderPage();
    await screen.findByText("Corner shop");

    const input = screen.getByLabelText("Scan receipt") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "receipt.jpg", { type: "image/jpeg" })] } });
    await screen.findByRole("dialog");
    await waitFor(() => expect(screen.queryByText("Uploading...")).not.toBeInTheDocument());

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Receipt detail brcpt_new")).toBeInTheDocument();
  });

  it("explains an empty month by pointing at the nearest month that has a receipt, and can go there", async () => {
    listMonthMock.mockImplementation(async (month: string) => {
      if (month === "2026-09") return { receipts: [], nearestMonthWithReceipts: "2026-07" };
      if (month === "2026-07") return { receipts: [readyReceipt], nearestMonthWithReceipts: null };
      return { receipts: [], nearestMonthWithReceipts: null };
    });
    renderPage();

    expect(await screen.findByText("No receipts in Sep 2026.")).toBeInTheDocument();
    const goButton = screen.getByRole("button", { name: /Go to Jul 2026/ });

    fireEvent.click(goButton);
    await screen.findByText("Corner shop");
    expect(screen.queryByText("No receipts in Sep 2026.")).not.toBeInTheDocument();
  });

  it("does not offer a nearest month when the user has no receipts anywhere", async () => {
    listMonthMock.mockResolvedValueOnce({ receipts: [], nearestMonthWithReceipts: null });
    renderPage();
    expect(await screen.findByText("No receipts match this view.")).toBeInTheDocument();
    expect(screen.queryByText(/Go to/)).not.toBeInTheDocument();
  });
});
