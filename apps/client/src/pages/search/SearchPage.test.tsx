import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "@/lib/search-api";
import { SearchPage } from "./SearchPage";

// Annotated rather than inferred: without this the first fixture's literal source
// narrows the mock's type, and a later fixture with a different source stops compiling.
const searchMock = vi.fn(async (_query: string, _limit?: number): Promise<{ results: SearchResult[]; query: string }> => ({
  results: [
    {
      documentId: "doc_1",
      documentName: "Lease agreement.pdf",
      chunkText: "The monthly rent is due on the first of the month.",
      chunkIndex: 0,
      score: 0.87,
      source: "hybrid",
      storageDriver: "local",
    },
  ],
  query: "rent",
}));

vi.mock("@/lib/search-api", () => ({
  searchApi: {
    search: (query: string, limit?: number) => searchMock(query, limit),
  },
}));

const storageDriversMock = vi.fn(async () => [
  { id: "local", label: "Local filesystem", guide: { title: "", intro: "", steps: [], notes: [] }, configured: true, documentCount: 1, active: true },
  { id: "s3", label: "Amazon S3", guide: { title: "", intro: "", steps: [], notes: [] }, configured: true, documentCount: 1, active: false },
]);
vi.mock("@/lib/storage-api", () => ({
  storageApi: { list: () => storageDriversMock() },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SearchPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SearchPage", () => {
  it("shows the empty state initially", () => {
    renderPage();
    expect(screen.getByText("Search your documents by keyword or meaning")).toBeInTheDocument();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("shows results after typing a query", async () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText("Search your documents..."), { target: { value: "rent" } });
    await waitFor(() => expect(searchMock).toHaveBeenCalledWith("rent", 20));
    expect(await screen.findByText("Lease agreement.pdf")).toBeInTheDocument();
    expect(screen.getByText("hybrid")).toBeInTheDocument();
  });

  it("links document names to their detail pages", async () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText("Search your documents..."), { target: { value: "rent" } });
    const link = await screen.findByRole("link", { name: "Lease agreement.pdf" });
    expect(link).toHaveAttribute("href", "/documents/doc_1");
  });

  it("does not badge a result held on the active storage", async () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText("Search your documents..."), { target: { value: "rent" } });
    await screen.findByText("Lease agreement.pdf");
    expect(screen.queryByText("Local filesystem")).not.toBeInTheDocument();
  });

  it("badges a result held on a storage that is not active", async () => {
    searchMock.mockResolvedValueOnce({
      results: [
        {
          documentId: "doc_2",
          documentName: "Old lease.pdf",
          chunkText: "The old lease is stored elsewhere.",
          chunkIndex: 0,
          score: 0.7,
          source: "keyword",
          storageDriver: "s3",
        },
      ],
      query: "rent",
    });
    renderPage();
    fireEvent.change(screen.getByPlaceholderText("Search your documents..."), { target: { value: "rent" } });
    await screen.findByText("Old lease.pdf");
    expect(screen.getByText("Amazon S3")).toBeInTheDocument();
  });
});
