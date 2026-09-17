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

vi.mock("@/lib/jobs-api", () => ({ jobsApi: { list: () => listJobsFn() } }));

vi.mock("@/lib/documents-api", () => ({ documentsApi: { list: () => listDocumentsFn() } }));

vi.mock("@/lib/sort-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sort-api")>("@/lib/sort-api");
  return {
    ...actual,
    sortApi: { list: () => listProposals(), count: (scope: string) => countFn(scope), run: (t: string, id: string, scope: string) => runFn(t, id, scope), apply: (accept: string[], dismiss: string[]) => applyFn(accept, dismiss) },
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

  it("accepts a selected proposal", async () => {
    renderPage();
    const checkbox = await screen.findByRole("checkbox");
    fireEvent.click(checkbox);
    // Wait for re-render after the checkbox state change so the button is enabled
    await waitFor(() => expect(screen.getByText("Accept selected").closest("button")).toBeEnabled());
    fireEvent.click(screen.getByText("Accept selected"));
    await waitFor(() => expect(applyFn).toHaveBeenCalledWith(["eval_1"], []));
  });
});
