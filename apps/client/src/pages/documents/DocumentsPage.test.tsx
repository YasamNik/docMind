import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
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
]);

vi.mock("@/lib/documents-api", () => ({
  documentsApi: { list: (filters?: unknown) => listMock(filters) },
}));
vi.mock("@/components/documents/UploadDropzone", () => ({ UploadDropzone: () => null }));

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

describe("DocumentsPage", () => {
  it("shows the category path and tag chips for each row", async () => {
    renderAt("/documents");
    expect(await screen.findByText("Finance / Tax")).toBeInTheDocument();
    expect(screen.getByText("Rent")).toBeInTheDocument();
  });

  it("shows a summary snippet below the document name", async () => {
    renderAt("/documents");
    expect(await screen.findByText("A rent invoice for January.")).toBeInTheDocument();
  });

  it("marks an auto-applied tag chip", async () => {
    renderAt("/documents");
    expect(await screen.findByText("Bills")).toBeInTheDocument();
    expect(screen.getByText("(auto)")).toBeInTheDocument();
  });

  it("reads categoryId, tagId, and view from the URL and passes them to the api", async () => {
    renderAt("/documents?categoryId=cat_1&tagId=tag_1&view=inbox");
    await screen.findByText("invoice.pdf");
    expect(listMock).toHaveBeenCalledWith({ categoryId: "cat_1", tagId: "tag_1", view: "inbox" });
    expect(screen.getByText("Inbox")).toBeInTheDocument();
  });
});
