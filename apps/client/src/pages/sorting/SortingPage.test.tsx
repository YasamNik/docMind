import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SortingPage } from "./SortingPage";

afterEach(() => cleanup());

const listForUser = vi.fn(async () => [{ id: "tag_1", name: "Rent", description: "Monthly rent", autoApply: true }]);
const listCategories = vi.fn(async () => [{ id: "cat_1", name: "Finance", path: "Finance", description: "Money matters", autoApply: true, parentId: null }]);
const listProposals = vi.fn(async () => ({
  proposals: [
    { id: "eval_1", documentId: "doc_1", documentName: "invoice.pdf", targetType: "tag", targetId: "tag_1", itemName: "Rent", kind: "add_tag", confidence: 0.9, reasoning: "Mentions rent." },
  ],
  nextCursor: null,
}));
const countFn = vi.fn(async (_scope: string) => 3);
const runFn = vi.fn(async (_t: string, _id: string, _scope: string) => ({ count: 3, jobIds: ["job_1", "job_2", "job_3"] }));
const applyFn = vi.fn(async (_accept: string[], _dismiss: string[]) => ({ appliedCount: 1, dismissedCount: 0 }));
const listJobsFn = vi.fn(async () => [] as unknown[]);
const listDocumentsFn = vi.fn(async () => [] as unknown[]);

vi.mock("@/lib/tags-api", () => ({
  tagsApi: { list: () => listForUser() },
  categoriesApi: { list: () => listCategories() },
}));

const listTypes = vi.fn(async () => [] as { id: string; name: string; description: string; autoApply: boolean }[]);
vi.mock("@/lib/types-api", () => ({
  typesApi: { list: () => listTypes() },
}));

vi.mock("@/lib/jobs-api", () => ({ jobsApi: { list: () => listJobsFn() } }));

vi.mock("@/lib/documents-api", () => ({ documentsApi: { list: () => listDocumentsFn() } }));

const backfillFn = vi.fn(async () => ({ enqueued: 2, skipped: 1 }));
vi.mock("@/lib/fields-api", () => ({ fieldsApi: { backfill: () => backfillFn() } }));

const suggestFn = vi.fn(async () => ({ suggestions: [{ name: "Legal", type: "tag", description: "Legal documents", reasoning: "Documents mention legal." }] }));
vi.mock("@/lib/sort-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sort-api")>("@/lib/sort-api");
  return {
    ...actual,
    sortApi: { list: () => listProposals(), count: (scope: string) => countFn(scope), run: (t: string, id: string, scope: string) => runFn(t, id, scope), apply: (accept: string[], dismiss: string[]) => applyFn(accept, dismiss), suggest: () => suggestFn() },
  };
});

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SortingPage />
    </QueryClientProvider>,
  );
}

describe("SortingPage", () => {
  beforeEach(() => {
    listJobsFn.mockReset().mockResolvedValue([]);
    listDocumentsFn.mockReset().mockResolvedValue([]);
    listTypes.mockReset().mockResolvedValue([]);
  });

  it("lists automatic items and proposed changes", async () => {
    renderPage();
    // "Rent" appears in both automatic items and proposal, so use getAllByText
    const rentElements = await screen.findAllByText("Rent");
    expect(rentElements.length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText("Finance")).toBeInTheDocument();
    expect(await screen.findByText(/invoice\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/Add tag/)).toBeInTheDocument();
  });

  it("shows no recent sorting activity when there are no rules jobs", async () => {
    renderPage();
    expect(await screen.findByText("No recent sorting activity.")).toBeInTheDocument();
  });

  it("shows active sorting progress with status badges while jobs are running", async () => {
    listJobsFn.mockResolvedValue([
      { id: "job_1", type: "rules", status: "processing", attempts: 0, error: null, payload: { documentId: "doc_1" }, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "job_2", type: "rules", status: "pending", attempts: 0, error: null, payload: { documentId: "doc_2" }, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    renderPage();
    expect(await screen.findByText("Sorting 2 documents... (0/2)")).toBeInTheDocument();
    expect(screen.getByText("processing")).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
  });

  it("shows completed results split into applied, proposed, and no match", async () => {
    listJobsFn.mockResolvedValue([
      { id: "job_1", type: "rules", status: "done", attempts: 1, error: null, payload: { documentId: "doc_a", targetType: "tag", targetId: "tag_9" }, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "job_2", type: "rules", status: "done", attempts: 1, error: null, payload: { documentId: "doc_b", targetType: "tag", targetId: "tag_9" }, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "job_3", type: "rules", status: "done", attempts: 1, error: null, payload: { documentId: "doc_c", targetType: "tag", targetId: "tag_9" }, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "job_4", type: "rules", status: "failed", attempts: 3, error: "boom", payload: { documentId: "doc_d", targetType: "tag", targetId: "tag_9" }, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    listDocumentsFn.mockResolvedValue([
      { id: "doc_b", name: "b.pdf", tags: [{ id: "tag_9", name: "Rent", color: null, auto: true, manual: false }], categoryId: null },
      { id: "doc_c", name: "c.pdf", tags: [], categoryId: null },
    ]);
    listProposals.mockResolvedValueOnce({
      proposals: [
        { id: "eval_a", documentId: "doc_a", documentName: "a.pdf", targetType: "tag", targetId: "tag_9", itemName: "Rent", kind: "add_tag", confidence: 0.9, reasoning: "Mentions rent." },
      ],
      nextCursor: null,
    });
    renderPage();
    expect(await screen.findByText("Completed: 1 applied, 1 proposed, 1 no match, 1 failed")).toBeInTheDocument();
    expect(screen.getByText("1 proposal waiting below")).toBeInTheDocument();
  });

  it("opens the run dialog with the scope count and runs it", async () => {
    renderPage();
    fireEvent.click((await screen.findAllByText("Run"))[0]!);
    expect(await screen.findByText(/3 documents will be re-evaluated/)).toBeInTheDocument();
    // The dialog's Run button is inside a dialog; find all Run buttons and click the last one (the dialog one)
    const runButtons = screen.getAllByRole("button", { name: "Run" });
    fireEvent.click(runButtons[runButtons.length - 1]!);
    await waitFor(() => expect(runFn).toHaveBeenCalled());
  });

  it("confirms before posting a fields backfill and states the document count and model call cost", async () => {
    listDocumentsFn.mockResolvedValue([
      { id: "doc_1", name: "a.pdf", extractionStatus: "done", tags: [], categoryId: null, fields: [] },
      { id: "doc_2", name: "b.pdf", extractionStatus: "done", tags: [], categoryId: null, fields: [{ key: "counterparty" }] },
    ]);
    renderPage();
    fireEvent.click(await screen.findByText("Extract fields for all documents"));
    expect(await screen.findByText(/1 document/)).toBeInTheDocument();
    expect(screen.getByText(/one model call/)).toBeInTheDocument();
    expect(backfillFn).not.toHaveBeenCalled();
  });

  it("does not post the backfill when the confirmation is dismissed", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("Extract fields for all documents"));
    await screen.findByText(/model call/);
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByText(/model call/)).not.toBeInTheDocument());
    expect(backfillFn).not.toHaveBeenCalled();
  });

  it("posts the backfill after confirming and reports the enqueued and skipped counts", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("Extract fields for all documents"));
    await screen.findByText(/model call/);
    fireEvent.click(screen.getByRole("button", { name: "Extract fields" }));
    await waitFor(() => expect(backfillFn).toHaveBeenCalled());
  });

  it("includes automatic types in the automatic items list", async () => {
    listTypes.mockResolvedValue([{ id: "dtype_1", name: "Invoice", description: "A request for payment.", autoApply: true }]);
    renderPage();
    expect(await screen.findByText("Invoice")).toBeInTheDocument();
    expect(screen.getByText("type")).toBeInTheDocument();
  });

  it("names all three taxonomies in the empty state once none has an automatic description", async () => {
    listForUser.mockResolvedValueOnce([]);
    listCategories.mockResolvedValueOnce([]);
    listTypes.mockResolvedValueOnce([]);
    renderPage();
    expect(await screen.findByText(/No tag, category, or type has both a description and automatic sorting turned on yet\./)).toBeInTheDocument();
  });

  it("accepts a selected proposal", async () => {
    renderPage();
    const checkbox = await screen.findByRole("checkbox");
    fireEvent.click(checkbox);
    // Wait for re-render after the checkbox state change so the button is enabled
    await waitFor(() => expect(screen.getByText("Accept selected").closest("button")).toBeEnabled());
    fireEvent.click(screen.getByText("Accept selected"));
    await waitFor(() => expect(applyFn).toHaveBeenCalledWith(["eval_1"], []));
  });

  it("shows rule suggestions without promising types or mentioning only the Tags page", async () => {
    suggestFn.mockResolvedValueOnce({ suggestions: [{ name: "Legal", type: "tag", description: "Legal documents", reasoning: "Documents mention legal." }] });
    renderPage();
    fireEvent.click(await screen.findByText("Suggest rules"));
    expect(await screen.findByText("Rule suggestions")).toBeInTheDocument();
    expect(screen.getByText(/Create these as tags and categories on their own pages, then enable auto-sorting\./)).toBeInTheDocument();
  });
});
