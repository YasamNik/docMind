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
  categoryId: null,
  categoryPath: null,
  categorySource: null,
  tags: [{ id: "tag_1", name: "Rent", color: null, auto: false, manual: true }],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const getMock = vi.fn(async () => documentDetail);
const setCategoryMock = vi.fn(async (_id: string, categoryId: string | null) => ({ ...documentDetail, categoryId }));
const addTagMock = vi.fn(async (_id: string, _tagId: string) => [...documentDetail.tags, { id: "tag_2", name: "Bills", color: null, auto: false, manual: true }]);
const removeTagMock = vi.fn(async (_id: string, _tagId: string) => []);

vi.mock("@/lib/documents-api", () => ({
  documentsApi: {
    get: () => getMock(),
    fileUrl: (id: string) => `/api/documents/${id}/file`,
    rename: vi.fn(),
    remove: vi.fn(),
    reextract: vi.fn(),
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
