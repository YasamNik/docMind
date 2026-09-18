import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentDetailPage } from "./DocumentDetailPage";

afterEach(() => cleanup());

const documentDetail = {
  id: "doc_1",
  name: "invoice.pdf",
  mimeType: "application/pdf",
  sizeBytes: 100,
  extractionStatus: "done" as const,
  extractionError: null,
  extractedText: "some text",
  categoryId: null as string | null,
  categoryPath: null as string | null,
  categorySource: null as "manual" | "auto" | null,
  documentTypeId: null as string | null,
  documentTypeName: null as string | null,
  tags: [{ id: "tag_1", name: "Rent", color: null, auto: false, manual: true }],
  fields: [] as {
    id: string;
    documentId: string;
    key: string;
    value: string;
    valueNumber: number | null;
    valueDate: string | null;
    currency: string | null;
    confidence: number | null;
    source: "llm" | "manual";
    createdAt: string;
    updatedAt: string;
  }[],
  summary: null as string | null,
  suggestedTitle: null as string | null,
  summaryStatus: "done" as "pending" | "processing" | "done" | "failed",
  summaryError: null as string | null,
  documentDate: null as string | null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const getMock = vi.fn(async () => documentDetail);
const setCategoryMock = vi.fn(async (_id: string, categoryId: string | null) => ({ ...documentDetail, categoryId }));
const addTagMock = vi.fn(async (_id: string, _tagId: string) => [...documentDetail.tags, { id: "tag_2", name: "Bills", color: null, auto: false, manual: true }]);
const removeTagMock = vi.fn(async (_id: string, _tagId: string) => []);
const acceptTitleMock = vi.fn(async (_id: string) => ({ ...documentDetail, name: documentDetail.suggestedTitle ?? documentDetail.name, suggestedTitle: null }));

vi.mock("@/lib/documents-api", () => ({
  documentsApi: {
    get: () => getMock(),
    fileUrl: (id: string) => `/api/documents/${id}/file`,
    rename: vi.fn(),
    remove: vi.fn(),
    reextract: vi.fn(),
    acceptTitle: (id: string) => acceptTitleMock(id),
  },
}));

const jobsListMock = vi.fn(async () => [] as { id: string; type: string; status: string; payload: { documentId?: string }; attempts: number; error: string | null; createdAt: string }[]);
const proposalsMock = vi.fn(async () => [] as { id: string; documentId: string; documentName: string; targetType: string; targetId: string; itemName: string; kind: string; confidence: number; reasoning: string }[]);
const requestSortMock = vi.fn(async () => ({ id: "job_1", status: "pending" }));
const applyProposalsMock = vi.fn(async (_accept: string[], _dismiss: string[]) => ({ appliedCount: 1, dismissedCount: 0 }));

vi.mock("@/lib/jobs-api", () => ({ jobsApi: { list: () => jobsListMock() } }));

vi.mock("@/lib/sort-api", () => ({
  sortApi: {
    listForDocument: () => proposalsMock(),
    requestSort: () => requestSortMock(),
    apply: (accept: string[], dismiss: string[]) => applyProposalsMock(accept, dismiss),
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/tags-api", () => ({
  categoriesApi: { list: vi.fn(async () => [{ id: "cat_1", name: "Finance", path: "Finance" }]) },
  tagsApi: { list: vi.fn(async () => [{ id: "tag_1", name: "Rent" }, { id: "tag_2", name: "Bills" }]) },
  documentCategorizationApi: {
    setCategory: (id: string, categoryId: string | null) => setCategoryMock(id, categoryId),
    addTag: (id: string, tagId: string) => addTagMock(id, tagId),
    removeTag: (id: string, tagId: string) => removeTagMock(id, tagId),
  },
}));

const setTypeMock = vi.fn(async (_id: string, documentTypeId: string | null) => ({ ...documentDetail, documentTypeId }));

vi.mock("@/lib/types-api", () => ({
  typesApi: { list: vi.fn(async () => [{ id: "dtype_1", name: "Invoice", color: "#4f46e5" }]) },
  documentTypeApi: {
    setType: (id: string, documentTypeId: string | null) => setTypeMock(id, documentTypeId),
  },
}));

function renderPage() {
  const queryClient = new QueryClient();
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <MemoryRouter initialEntries={["/documents/doc_1"]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/documents/:id" element={<DocumentDetailPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { invalidateSpy };
}

describe("DocumentDetailPage document date", () => {
  afterEach(() => {
    getMock.mockImplementation(async () => documentDetail);
  });

  it("shows the extracted document date when present", async () => {
    getMock.mockImplementationOnce(async () => ({ ...documentDetail, documentDate: "2026-02-14" }));
    renderPage();
    expect(await screen.findByText(/document date Feb 14, 2026/)).toBeInTheDocument();
  });

  it("does not show a document date line when there is none", async () => {
    renderPage();
    await screen.findByText("Rent");
    expect(screen.queryByText(/document date/)).not.toBeInTheDocument();
  });
});

describe("DocumentDetailPage pickers", () => {
  it("shows the current tag and lets the category be changed", async () => {
    renderPage();
    expect(await screen.findByText("Rent")).toBeInTheDocument();
    const select = await screen.findByDisplayValue("No category");
    fireEvent.change(select, { target: { value: "cat_1" } });
    await waitFor(() => expect(setCategoryMock).toHaveBeenCalledWith("doc_1", "cat_1"));
  });

  it("adds and removes a tag", async () => {
    renderPage();
    const addSelect = await screen.findByDisplayValue("Add a tag");
    fireEvent.change(addSelect, { target: { value: "tag_2" } });
    await waitFor(() => expect(addTagMock).toHaveBeenCalledWith("doc_1", "tag_2"));

    fireEvent.click(screen.getByLabelText("Remove Rent"));
    await waitFor(() => expect(removeTagMock).toHaveBeenCalledWith("doc_1", "tag_1"));
  });

  it("refreshes category and tag counts after changing the category", async () => {
    const { invalidateSpy } = renderPage();
    const select = await screen.findByDisplayValue("No category");
    fireEvent.change(select, { target: { value: "cat_1" } });
    await waitFor(() => expect(setCategoryMock).toHaveBeenCalled());
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["categories"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["tags"] });
  });

  it("refreshes category and tag counts after adding and removing a tag", async () => {
    const { invalidateSpy } = renderPage();
    const addSelect = await screen.findByDisplayValue("Add a tag");
    fireEvent.change(addSelect, { target: { value: "tag_2" } });
    await waitFor(() => expect(addTagMock).toHaveBeenCalled());
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["categories"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["tags"] });

    invalidateSpy.mockClear();
    fireEvent.click(screen.getByLabelText("Remove Rent"));
    await waitFor(() => expect(removeTagMock).toHaveBeenCalled());
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["categories"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["tags"] });
  });
});

describe("DocumentDetailPage type and category", () => {
  afterEach(() => {
    getMock.mockImplementation(async () => documentDetail);
  });

  it("shows the category as plain breadcrumb text and the type as a distinct colored badge", async () => {
    getMock.mockImplementationOnce(async () => ({ ...documentDetail, categoryPath: "Finance", documentTypeId: "dtype_1", documentTypeName: "Invoice" }));
    renderPage();
    const category = await screen.findByText("Finance");
    const type = await screen.findByText("Invoice");
    // The category label stays a plain breadcrumb string, never wrapped in a Badge.
    expect(category.closest('[data-slot="badge"]')).toBeNull();
    // The type reads as a chip, not a second breadcrumb, so the two never look alike.
    expect(type.closest('[data-slot="badge"]')).not.toBeNull();
  });

  it("lets the type be changed with its own picker", async () => {
    renderPage();
    const select = await screen.findByDisplayValue("No type");
    // Wait for the types list to finish loading so the option actually exists before
    // the change event fires, otherwise jsdom silently drops the requested value.
    await screen.findByText("Invoice");
    fireEvent.change(select, { target: { value: "dtype_1" } });
    await waitFor(() => expect(setTypeMock).toHaveBeenCalledWith("doc_1", "dtype_1"));
  });

  it("shows nothing for type when the document has none", async () => {
    renderPage();
    await screen.findByText("Rent");
    expect(screen.queryByText("Invoice")).not.toBeInTheDocument();
  });
});

describe("DocumentDetailPage rules", () => {
  it("queues a rerun with the Run rules button", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("Run rules"));
    await waitFor(() => expect(requestSortMock).toHaveBeenCalled());
  });

  it("shows a review button with the proposal count and applies a selected one", async () => {
    proposalsMock.mockResolvedValueOnce([
      { id: "eval_1", documentId: "doc_1", documentName: "invoice.pdf", targetType: "tag", targetId: "tag_2", itemName: "Bills", kind: "add_tag", confidence: 0.8, reasoning: "Mentions bills." },
    ]);
    renderPage();
    fireEvent.click(await screen.findByText("Review proposals (1)"));
    fireEvent.click(screen.getByLabelText((_, el) => el?.tagName.toLowerCase() === "input" && el?.getAttribute("type") === "checkbox"));
    fireEvent.click(screen.getByText("Accept selected"));
    await waitFor(() => expect(applyProposalsMock).toHaveBeenCalledWith(["eval_1"], []));
  });

  it("shows nothing extra when there are no proposals", async () => {
    renderPage();
    await screen.findByText("Rent");
    expect(screen.queryByText(/Review proposals/)).not.toBeInTheDocument();
  });
});

describe("DocumentDetailPage summary", () => {
  afterEach(() => {
    getMock.mockImplementation(async () => documentDetail);
  });

  it("shows the summary card when a summary is present", async () => {
    getMock.mockImplementationOnce(async () => ({ ...documentDetail, summary: "A short summary of the invoice." }));
    renderPage();
    expect(await screen.findByText("A short summary of the invoice.")).toBeInTheDocument();
  });

  it("shows no summary card when there is no summary and status is done", async () => {
    renderPage();
    await screen.findByText("Rent");
    expect(screen.queryByText("Summary")).not.toBeInTheDocument();
  });

  it("shows a summarizing indicator while summaryStatus is processing", async () => {
    getMock.mockImplementationOnce(async () => ({ ...documentDetail, summaryStatus: "processing" as const }));
    renderPage();
    expect(await screen.findByText("Summarizing...")).toBeInTheDocument();
  });

  it("shows the error when summaryStatus is failed", async () => {
    getMock.mockImplementationOnce(async () => ({ ...documentDetail, summaryStatus: "failed" as const, summaryError: "Model timed out" }));
    renderPage();
    expect(await screen.findByText("Model timed out")).toBeInTheDocument();
  });

  it("shows a suggested title badge and accepts it", async () => {
    getMock.mockImplementationOnce(async () => ({ ...documentDetail, suggestedTitle: "January Invoice" }));
    renderPage();
    expect(await screen.findByText("Suggested title")).toBeInTheDocument();
    expect(screen.getByText("January Invoice")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Accept"));
    await waitFor(() => expect(acceptTitleMock).toHaveBeenCalledWith("doc_1"));
  });

  it("hides the badge when there is no suggested title", async () => {
    renderPage();
    await screen.findByText("Rent");
    expect(screen.queryByText("Suggested title")).not.toBeInTheDocument();
  });

  it("hides the badge when the suggested title matches the current name", async () => {
    getMock.mockImplementationOnce(async () => ({ ...documentDetail, suggestedTitle: documentDetail.name }));
    renderPage();
    await screen.findByText("Rent");
    expect(screen.queryByText("Suggested title")).not.toBeInTheDocument();
  });
});

describe("DocumentDetailPage extracted fields", () => {
  afterEach(() => {
    getMock.mockImplementation(async () => documentDetail);
  });

  it("shows the extracted fields that are present", async () => {
    getMock.mockImplementationOnce(async () => ({
      ...documentDetail,
      fields: [
        {
          id: "f_1",
          documentId: "doc_1",
          key: "status",
          value: "paid",
          valueNumber: null,
          valueDate: null,
          currency: null,
          confidence: 0.95,
          source: "llm" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "f_2",
          documentId: "doc_1",
          key: "amountTotal",
          value: "120.50",
          valueNumber: 120.5,
          valueDate: null,
          currency: "USD",
          confidence: 0.9,
          source: "llm" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "f_3",
          documentId: "doc_1",
          key: "counterparty",
          value: "Acme",
          valueNumber: null,
          valueDate: null,
          currency: null,
          confidence: null,
          source: "llm" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }));
    renderPage();
    expect(await screen.findByText("Paid")).toBeInTheDocument();
    expect(screen.getByText("120.50")).toBeInTheDocument();
    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });

  it("does not show the document date among the extracted fields, since it has its own line", async () => {
    getMock.mockImplementationOnce(async () => ({
      ...documentDetail,
      documentDate: "2026-02-14",
      fields: [
        {
          id: "f_1",
          documentId: "doc_1",
          key: "dueDate",
          value: "2026-03-01",
          valueNumber: null,
          valueDate: "2026-03-01",
          currency: null,
          confidence: null,
          source: "llm" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }));
    renderPage();
    expect(await screen.findByText(/document date Feb 14, 2026/)).toBeInTheDocument();
    expect(screen.getByText("Due")).toBeInTheDocument();
    expect(screen.getAllByText(/Feb 14, 2026/)).toHaveLength(1);
  });

  it("shows nothing at all when the document has no extracted fields", async () => {
    renderPage();
    await screen.findByText("Rent");
    expect(screen.queryByText("Extracted details")).not.toBeInTheDocument();
  });
});
