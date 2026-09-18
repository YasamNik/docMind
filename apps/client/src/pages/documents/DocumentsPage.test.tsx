import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentsPage } from "./DocumentsPage";

afterEach(() => cleanup());

// Local noon on purpose: the date filter reasons about local calendar days, so fixture
// timestamps are built from local time instead of literal UTC "Z" strings to land on the
// intended day regardless of the machine's timezone.
function localIso(year: number, month: number, day: number) {
  return new Date(year, month - 1, day, 12, 0, 0).toISOString();
}

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
    fields: [
      {
        id: "field_1",
        documentId: "doc_1",
        key: "counterparty",
        value: "Acme Corp",
        valueNumber: null,
        valueDate: null,
        currency: null,
        confidence: 0.9,
        source: "llm",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "field_1b",
        documentId: "doc_1",
        key: "expiryDate",
        value: "2099-03-01",
        valueNumber: null,
        valueDate: "2099-03-01",
        currency: null,
        confidence: 0.8,
        source: "llm",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    summary: "A rent invoice for January.",
    suggestedTitle: null,
    summaryStatus: "done",
    summaryError: null,
    documentDate: "2026-01-01",
    createdAt: localIso(2026, 1, 1),
    updatedAt: localIso(2026, 1, 1),
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
    fields: [
      {
        id: "field_2",
        documentId: "doc_2",
        key: "counterparty",
        value: "Globex",
        valueNumber: null,
        valueDate: null,
        currency: null,
        confidence: 0.9,
        source: "llm",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "field_2b",
        documentId: "doc_2",
        key: "expiryDate",
        value: "2020-02-01",
        valueNumber: null,
        valueDate: "2020-02-01",
        currency: null,
        confidence: 0.8,
        source: "llm",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ],
    summary: null,
    suggestedTitle: null,
    summaryStatus: "done",
    summaryError: null,
    documentDate: null,
    createdAt: localIso(2026, 1, 2),
    updatedAt: localIso(2026, 1, 2),
  },
]);

vi.mock("@/lib/documents-api", () => ({
  documentsApi: { list: (filters?: unknown) => listMock(filters) },
}));
vi.mock("@/components/documents/UploadDropzone", () => ({ UploadDropzone: () => null }));
const fieldValuesMock = vi.fn(async (_key: string) => ["invoice", "receipt"]);
vi.mock("@/lib/fields-api", () => ({
  fieldsApi: { values: (key: string) => fieldValuesMock(key) },
}));
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
    renderAt("/documents?categoryId=cat_1&tagId=tag_1&view=needs_review");
    await screen.findByText("invoice.pdf");
    expect(listMock).toHaveBeenCalledWith({ categoryId: "cat_1", tagId: "tag_1", view: "needs_review" });
    expect(screen.getByText("Needs review")).toBeInTheDocument();
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

  it("shows the extracted document date or a dash in the Doc Date column", async () => {
    const { container } = renderAt("/documents");
    await screen.findByText("invoice.pdf");
    const body = tableBody(container);
    expect(within(body).getByText("Jan 1, 2026")).toBeInTheDocument();
    expect(within(body).getByText("-")).toBeInTheDocument();
  });

  it("filters by a custom added date range and shows a clearable active filter", async () => {
    renderAt("/documents");
    await screen.findByText("invoice.pdf");
    await screen.findByText("note.txt");
    fireEvent.change(screen.getByLabelText("Filter by added date"), { target: { value: "custom" } });
    fireEvent.change(await screen.findByLabelText("Filter by added date, start date"), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("Filter by added date, end date"), { target: { value: "2026-01-01" } });
    await waitFor(() => expect(screen.queryByText("note.txt")).not.toBeInTheDocument());
    expect(screen.getByText("invoice.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear added date filter" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear added date filter" }));
    await waitFor(() => expect(screen.getByText("note.txt")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Clear added date filter" })).not.toBeInTheDocument();
  });

  it("filters out documents with no document date once a doc date range is set", async () => {
    renderAt("/documents");
    await screen.findByText("invoice.pdf");
    await screen.findByText("note.txt");
    fireEvent.change(screen.getByLabelText("Filter by document date"), { target: { value: "custom" } });
    fireEvent.change(await screen.findByLabelText("Filter by document date, start date"), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("Filter by document date, end date"), { target: { value: "2026-01-01" } });
    await waitFor(() => expect(screen.queryByText("note.txt")).not.toBeInTheDocument());
    expect(screen.getByText("invoice.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear document date filter" })).toBeInTheDocument();
  });

  it("shows the expiry date read from the smart field", async () => {
    renderAt("/documents");
    await screen.findByText("invoice.pdf");
    expect(await screen.findByText("Mar 1, 2099")).toBeInTheDocument();
    expect(screen.getByText("Feb 1, 2020")).toBeInTheDocument();
  });

  it("marks a past expiry date in red and says so for a screen reader", async () => {
    renderAt("/documents");
    const expired = await screen.findByText("Feb 1, 2020");
    // The colour alone would not reach a screen reader, so the cell carries the word too.
    expect(expired.closest("td")).toHaveTextContent("expired");
    expect(expired.closest("td")?.className).toContain("text-destructive");
  });

  it("does not mark a future expiry date as expired", async () => {
    renderAt("/documents");
    const future = await screen.findByText("Mar 1, 2099");
    expect(future.closest("td")).not.toHaveTextContent("expired");
    expect(future.closest("td")?.className).not.toContain("text-destructive");
  });
});
