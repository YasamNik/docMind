import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

vi.mock("@/lib/tags-api", () => ({
  tagsApi: { list: () => listForUser() },
  categoriesApi: { list: () => listCategories() },
}));

vi.mock("@/lib/jobs-api", () => ({ jobsApi: { list: vi.fn(async () => []) } }));

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
  it("lists automatic items and proposed changes", async () => {
    renderPage();
    // "Rent" appears in both automatic items and proposal, so use getAllByText
    const rentElements = await screen.findAllByText("Rent");
    expect(rentElements.length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText("Finance")).toBeInTheDocument();
    expect(await screen.findByText(/invoice\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/Add tag/)).toBeInTheDocument();
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
