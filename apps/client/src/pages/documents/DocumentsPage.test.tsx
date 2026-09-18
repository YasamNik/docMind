import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentsPage } from "./DocumentsPage";

afterEach(() => cleanup());

const listMock = vi.fn(async (_filters?: unknown) => [
  {
    id: "doc_1",
    name: "invoice.pdf",
    mimeType: "application/pdf",
    sizeBytes: 100,
    extractionStatus: "done",
    extractionError: null,
    categoryId: "cat_1",
    categoryPath: "Finance / Tax",
    tags: [
      { id: "tag_1", name: "Rent", color: null, auto: false, manual: true },
      { id: "tag_2", name: "Bills", color: null, auto: true, manual: false },
    ],
    summary: "A rent invoice for January.",
    suggestedTitle: null,
    summaryStatus: "done",
    summaryError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "doc_2",
    name: "note.txt",
    mimeType: "text/plain",
    sizeBytes: 20,
    extractionStatus: "done",
    extractionError: null,
    categoryId: null,
    categoryPath: null,
    tags: [],
    summary: null,
    suggestedTitle: null,
    summaryStatus: "done",
    summaryError: null,
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
]);

vi.mock("@/lib/documents-api", () => ({
  documentsApi: { list: (filters?: unknown) => listMock(filters) },
}));
vi.mock("@/components/documents/UploadDropzone", () => ({ UploadDropzone: () => null }));
vi.mock("@/lib/tags-api", () => ({
  categoriesApi: { list: vi.fn(async () => [{ id: "cat_1", name: "Finance", parentId: null, path: "Finance / Tax", documentCount: 1 }]) },
  tagsApi: {
    list: vi.fn(async () => [
      { id: "tag_1", name: "Rent", documentCount: 1 },
      { id: "tag_2", name: "Bills", documentCount: 1 },
    ]),
  },
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient()}>
        <Routes>
          <Route path="/documents" element={<DocumentsPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function tableBody(container: HTMLElement) {
  return container.querySelector('[data-slot="table-body"]') as HTMLElement;
}

describe("DocumentsPage", () => {
  it("shows the category path and tag chips for each row", async () => {
    const { container } = renderAt("/documents");
    await screen.findByText("invoice.pdf");
    const body = tableBody(container);
    expect(within(body).getByText("Finance / Tax")).toBeInTheDocument();
    expect(within(body).getByText("Rent")).toBeInTheDocument();
  });

  it("shows a summary snippet below the document name", async () => {
    renderAt("/documents");
    expect(await screen.findByText("A rent invoice for January.")).toBeInTheDocument();
  });

  it("marks an auto-applied tag chip", async () => {
    const { container } = renderAt("/documents");
    await screen.findByText("invoice.pdf");
    const body = tableBody(container);
    expect(within(body).getByText("Bills")).toBeInTheDocument();
    expect(within(body).getByText("(auto)")).toBeInTheDocument();
  });

  it("reads categoryId, tagId, and view from the URL and passes them to the api", async () => {
    renderAt("/documents?categoryId=cat_1&tagId=tag_1&view=inbox");
    await screen.findByText("invoice.pdf");
    expect(listMock).toHaveBeenCalledWith({ categoryId: "cat_1", tagId: "tag_1", view: "inbox" });
    expect(screen.getByText("Inbox")).toBeInTheDocument();
  });

  it("filters by category using the header dropdown and shows a clearable active filter", async () => {
    renderAt("/documents");
    await screen.findByText("invoice.pdf");
    const categorySelect = screen.getByLabelText("Filter by category") as HTMLSelectElement;
    fireEvent.change(categorySelect, { target: { value: "cat_1" } });
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith({ categoryId: "cat_1", tagId: undefined, view: "all" }));
    expect(categorySelect.value).toBe("cat_1");
    expect(screen.getByRole("button", { name: "Clear category filter" })).toBeInTheDocument();
  });

  it("filters to uncategorized documents when None is selected in the category dropdown", async () => {
    renderAt("/documents");
    await screen.findByText("invoice.pdf");
    await screen.findByText("note.txt");
    const categorySelect = screen.getByLabelText("Filter by category") as HTMLSelectElement;
    fireEvent.change(categorySelect, { target: { value: "none" } });
    await waitFor(() => expect(screen.queryByText("invoice.pdf")).not.toBeInTheDocument());
    expect(screen.getByText("note.txt")).toBeInTheDocument();
  });

  it("filters by tag using the header dropdown and shows a clearable active filter", async () => {
    renderAt("/documents");
    await screen.findByText("invoice.pdf");
    const tagSelect = screen.getByLabelText("Filter by tags") as HTMLSelectElement;
    fireEvent.change(tagSelect, { target: { value: "tag_1" } });
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith({ categoryId: undefined, tagId: "tag_1", view: "all" }));
    expect(tagSelect.value).toBe("tag_1");
    expect(screen.getByRole("button", { name: "Clear tag filter" })).toBeInTheDocument();
  });

  it("clears the category filter when the active filter badge is dismissed", async () => {
    renderAt("/documents?categoryId=cat_1");
    await screen.findByText("invoice.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Clear category filter" }));
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith({ categoryId: undefined, tagId: undefined, view: "all" }));
    expect(screen.queryByRole("button", { name: "Clear category filter" })).not.toBeInTheDocument();
  });
});
