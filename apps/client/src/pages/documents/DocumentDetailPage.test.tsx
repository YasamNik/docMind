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
  storageLocation: null as { label: string; url?: string } | null,
  storageDriver: "local",
  parentDocumentId: null as string | null,
  parent: null as { id: string; name: string } | null,
  children: [] as { id: string; name: string }[],
};

const getMock = vi.fn(async () => documentDetail);
const setCategoryMock = vi.fn(async (_id: string, categoryId: string | null) => ({ ...documentDetail, categoryId }));
const addTagMock = vi.fn(async (_id: string, _tagId: string) => [...documentDetail.tags, { id: "tag_2", name: "Bills", color: null, auto: false, manual: true }]);
const removeTagMock = vi.fn(async (_id: string, _tagId: string) => []);
const acceptTitleMock = vi.fn(async (_id: string) => ({ ...documentDetail, name: documentDetail.suggestedTitle ?? documentDetail.name, suggestedTitle: null }));
const fileErrorCodeMock = vi.fn(async (_id: string): Promise<string | null> => null);

vi.mock("@/lib/documents-api", () => ({
  documentsApi: {
    get: () => getMock(),
    fileUrl: (id: string, download = false) => `/api/documents/${id}/file${download ? "?download=1" : ""}`,
    fileErrorCode: (id: string) => fileErrorCodeMock(id),
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
  return { invalidateSpy, queryClient };
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

describe("DocumentDetailPage storage location", () => {
  afterEach(() => {
    getMock.mockImplementation(async () => documentDetail);
  });

  it("shows the preview and a Download button when the document is on the active storage", async () => {
    renderPage();
    expect(await screen.findByTitle("Preview")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/documents/doc_1/file?download=1");
  });

  it("shows the location as a link and hides the preview and download when off the active storage", async () => {
    getMock.mockImplementationOnce(async () => ({
      ...documentDetail,
      storageLocation: { label: "s3://bucket/docs/invoice.pdf", url: "https://console.aws.amazon.com/s3/object/bucket?prefix=docs/invoice.pdf" },
    }));
    renderPage();

    expect(await screen.findByRole("link", { name: "s3://bucket/docs/invoice.pdf" })).toHaveAttribute(
      "href",
      "https://console.aws.amazon.com/s3/object/bucket?prefix=docs/invoice.pdf",
    );
    expect(screen.queryByTitle("Preview")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Download" })).not.toBeInTheDocument();
  });

  it("shows the location as plain text when there is no url", async () => {
    getMock.mockImplementationOnce(async () => ({
      ...documentDetail,
      storageLocation: { label: "/data/documents/doc_1/invoice.pdf" },
    }));
    renderPage();

    expect(await screen.findByText("/data/documents/doc_1/invoice.pdf")).toBeInTheDocument();
    expect(screen.queryByTitle("Preview")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Download" })).not.toBeInTheDocument();
  });

  it("still shows text, tags and other metadata when the document is off the active storage", async () => {
    getMock.mockImplementationOnce(async () => ({
      ...documentDetail,
      storageLocation: { label: "s3://bucket/docs/invoice.pdf" },
    }));
    renderPage();

    expect(await screen.findByText("Rent")).toBeInTheDocument();
    expect(screen.getByText("some text")).toBeInTheDocument();
  });
});

describe("DocumentDetailPage related documents", () => {
  afterEach(() => {
    getMock.mockImplementation(async () => documentDetail);
  });

  it("links to the parent mail when this document is an attachment", async () => {
    getMock.mockImplementationOnce(async () => ({ ...documentDetail, parent: { id: "doc_mail", name: "mail.txt" } }));
    renderPage();
    const link = await screen.findByRole("link", { name: "mail.txt" });
    expect(link).toHaveAttribute("href", "/documents/doc_mail");
  });

  it("links to each attachment when this document is a mail", async () => {
    getMock.mockImplementationOnce(async () => ({
      ...documentDetail,
      children: [
        { id: "doc_att1", name: "invoice.pdf" },
        { id: "doc_att2", name: "receipt.pdf" },
      ],
    }));
    renderPage();
    expect(await screen.findByRole("link", { name: "invoice.pdf" })).toHaveAttribute("href", "/documents/doc_att1");
    expect(screen.getByRole("link", { name: "receipt.pdf" })).toHaveAttribute("href", "/documents/doc_att2");
  });

  it("shows nothing when there is no parent and no attachments", async () => {
    renderPage();
    await screen.findByText("Rent");
    expect(screen.queryByText(/Attachment to/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Attachments:/)).not.toBeInTheDocument();
  });
});

describe("DocumentDetailPage file access", () => {
  afterEach(() => {
    getMock.mockImplementation(async () => documentDetail);
    fileErrorCodeMock.mockReset().mockResolvedValue(null);
  });

  it("shows a reconnect message instead of a broken image when storage needs reauthorizing", async () => {
    getMock.mockImplementationOnce(async () => ({ ...documentDetail, mimeType: "image/png" }));
    fileErrorCodeMock.mockResolvedValueOnce("storage.reauth_required");
    renderPage();
    const image = await screen.findByAltText("Preview");

    fireEvent.error(image);

    expect(await screen.findByText(/needs to be reconnected/i)).toBeInTheDocument();
    expect(fileErrorCodeMock).toHaveBeenCalledWith("doc_1");
    expect(screen.queryByAltText("Preview")).not.toBeInTheDocument();
  });

  it("marks the document's storage driver as needing reauthorization", async () => {
    getMock.mockImplementationOnce(async () => ({ ...documentDetail, mimeType: "image/png" }));
    fileErrorCodeMock.mockResolvedValueOnce("storage.reauth_required");
    const { queryClient } = renderPage();
    const image = await screen.findByAltText("Preview");

    fireEvent.error(image);
    await screen.findByText(/needs to be reconnected/i);

    expect(queryClient.getQueryData(["storage-reauth", "local"])).toBe(true);
  });

  it("leaves the preview as is when the image fails for an unrelated reason", async () => {
    getMock.mockImplementationOnce(async () => ({ ...documentDetail, mimeType: "image/png" }));
    fileErrorCodeMock.mockResolvedValueOnce(null);
    renderPage();
    const image = await screen.findByAltText("Preview");

    fireEvent.error(image);

    await waitFor(() => expect(fileErrorCodeMock).toHaveBeenCalledWith("doc_1"));
    expect(screen.queryByText(/needs to be reconnected/i)).not.toBeInTheDocument();
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
          key: "documentType",
          value: "invoice",
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
    expect(await screen.findByText("Invoice")).toBeInTheDocument();
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

  it("stacks into one column below md and reads as three columns from md up", async () => {
    getMock.mockImplementationOnce(async () => ({
      ...documentDetail,
      fields: [
        {
          id: "f_1",
          documentId: "doc_1",
          key: "documentType",
          value: "invoice",
          valueNumber: null,
          valueDate: null,
          currency: null,
          confidence: 0.95,
          source: "llm" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }));
    renderPage();
    const term = await screen.findByText("Type");
    const grid = term.closest("dl");
    expect(grid?.className).toContain("grid-cols-1");
    expect(grid?.className).toContain("md:grid-cols-3");
  });
});

describe("DocumentDetailPage layout stacking", () => {
  afterEach(() => {
    getMock.mockImplementation(async () => documentDetail);
  });

  it("stacks the title and the action buttons below md and puts them side by side from md up", async () => {
    renderPage();
    const heading = await screen.findByRole("heading", { name: "invoice.pdf" });
    const header = heading.closest("div")?.parentElement;
    expect(header?.className).toContain("flex-col");
    expect(header?.className).toContain("md:flex-row");
  });

  it("gives the PDF preview a shorter max height below md than from md up", async () => {
    renderPage();
    const preview = await screen.findByTitle("Preview");
    expect(preview.className).toContain("h-[45vh]");
    expect(preview.className).toContain("md:h-[70vh]");
  });
});
