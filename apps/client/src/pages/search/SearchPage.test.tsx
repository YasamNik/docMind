import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchPage } from "./SearchPage";

const searchMock = vi.fn(async (_query: string, _limit?: number) => ({
  results: [
    {
      documentId: "doc_1",
      documentName: "Lease agreement.pdf",
      chunkText: "The monthly rent is due on the first of the month.",
      chunkIndex: 0,
      score: 0.87,
      source: "hybrid" as const,
    },
  ],
  query: "rent",
}));

vi.mock("@/lib/search-api", () => ({
  searchApi: {
    search: (query: string, limit?: number) => searchMock(query, limit),
  },
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
    expect(screen.getByText("87%")).toBeInTheDocument();
    expect(screen.getByText("hybrid")).toBeInTheDocument();
  });

  it("links document names to their detail pages", async () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText("Search your documents..."), { target: { value: "rent" } });
    const link = await screen.findByRole("link", { name: "Lease agreement.pdf" });
    expect(link).toHaveAttribute("href", "/documents/doc_1");
  });
});
