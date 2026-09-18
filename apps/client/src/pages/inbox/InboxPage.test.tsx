import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxPage } from "./InboxPage";

const listMock = vi.fn(async (_filters?: Record<string, string>) => [
  {
    id: "doc_0000000000000001",
    name: "invoice.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
    extractionStatus: "done" as const,
    extractionError: null,
    categoryId: "cat_1",
    categoryPath: "Finance",
    tags: [{ id: "tag_1", name: "Receipt", color: null, auto: true, manual: false }],
    summary: "An invoice for consulting services.",
    suggestedTitle: "Consulting Invoice Q3",
    summaryStatus: "done" as const,
    summaryError: null,
    documentDate: null,
    triageStatus: "pending" as const,
    createdAt: "2026-09-17T00:00:00Z",
    updatedAt: "2026-09-17T00:00:00Z",
  },
]);

const acceptTriageBatchMock = vi.fn(async (_ids?: string[]) => ({ updatedCount: 1 }));

vi.mock("@/lib/documents-api", () => ({
  documentsApi: {
    list: (filters?: Record<string, string>) => listMock(filters),
    acceptTriageBatch: (ids: string[]) => acceptTriageBatchMock(ids),
    listEvaluations: vi.fn(async () => []),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("InboxPage", () => {
  it("shows inbox cards with document info", async () => {
    renderPage();
    expect(await screen.findByText("Consulting Invoice Q3")).toBeInTheDocument();
    expect(screen.getByText("An invoice for consulting services.")).toBeInTheDocument();
    expect(screen.getByText("Finance")).toBeInTheDocument();
    expect(screen.getByText("Receipt")).toBeInTheDocument();
  });

  it("shows empty state when no documents", async () => {
    listMock.mockResolvedValueOnce([]);
    renderPage();
    expect(await screen.findByText("All caught up. No new documents to review.")).toBeInTheDocument();
  });

  it("renders accept buttons for each card", async () => {
    renderPage();
    expect(await screen.findByText("Accept with title")).toBeInTheDocument();
  });
});
