import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { CategoryRow } from "@/lib/tags-api";
import { CategoriesPage } from "./CategoriesPage";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const listMock = vi.fn(async (): Promise<CategoryRow[]> => [
  {
    id: "cat_1",
    name: "Finance",
    parentId: null,
    color: null,
    description: "",
    confidenceThreshold: 0.7,
    autoApply: true,
    sortOrder: 0,
    path: "Finance",
    documentCount: 3,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "cat_2",
    name: "Personal",
    parentId: null,
    color: null,
    description: "",
    confidenceThreshold: 0.7,
    autoApply: true,
    sortOrder: 1,
    path: "Personal",
    documentCount: 0,
    createdAt: "",
    updatedAt: "",
  },
]);
const createMock = vi.fn(async (input: unknown) => ({ id: "cat_3", documentCount: 0, sortOrder: 2, path: "Tax", createdAt: "", updatedAt: "", ...(input as object) }));
const removeMock = vi.fn(async (_id: string) => undefined);
const updateMock = vi.fn(async (id: string, patch: unknown) => ({ id, ...(patch as object) }));
const reorderMock = vi.fn(async (a: { id: string; sortOrder: number }, b: { id: string; sortOrder: number }) => [a, b]);

vi.mock("@/lib/documents-api", () => ({ documentsApi: { list: vi.fn(async () => [{ id: "doc_1", name: "invoice.pdf" }]) } }));
vi.mock("@/lib/sort-api", () => ({ sortApi: { dryRun: vi.fn(async () => ({ matched: false, confidence: 0, reasoning: "", wouldApply: false })) } }));

vi.mock("@/lib/tags-api", () => ({
  categoriesApi: {
    list: () => listMock(),
    create: (input: unknown) => createMock(input),
    update: (id: string, patch: unknown) => updateMock(id, patch),
    remove: (id: string) => removeMock(id),
    reorder: (a: { id: string; sortOrder: number }, b: { id: string; sortOrder: number }) => reorderMock(a, b),
  },
}));

function renderPage() {
  const queryClient = new QueryClient();
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <CategoriesPage />
    </QueryClientProvider>,
  );
  return { invalidateSpy };
}

describe("CategoriesPage", () => {
  it("lists existing categories with their path and document count", async () => {
    renderPage();
    expect(await screen.findByText("Finance")).toBeInTheDocument();
    expect(screen.getByText("3 documents")).toBeInTheDocument();
  });

  it("creates a new category with a parent", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("New category"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Tax" } });
    fireEvent.change(dialog.getByLabelText("Parent"), { target: { value: "cat_1" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ name: "Tax", parentId: "cat_1" })));
  });

  it("moves a category down by swapping sortOrder with its next sibling in one request", async () => {
    renderPage();
    await screen.findByText("Finance");
    fireEvent.click(screen.getByLabelText("Move Finance down"));
    await waitFor(() => {
      expect(reorderMock).toHaveBeenCalledWith({ id: "cat_1", sortOrder: 1 }, { id: "cat_2", sortOrder: 0 });
    });
  });

  it("does nothing when moving the first category up", async () => {
    renderPage();
    await screen.findByText("Finance");
    fireEvent.click(screen.getByLabelText("Move Finance up"));
    expect(reorderMock).not.toHaveBeenCalled();
  });

  it("deletes a category after confirming and refreshes the documents query", async () => {
    const { invalidateSpy } = renderPage();
    fireEvent.click((await screen.findAllByText("Delete"))[0]);
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("cat_1"));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["documents"] });
  });

  it("edits a category, saves the change, and refreshes the documents query", async () => {
    const { invalidateSpy } = renderPage();
    fireEvent.click((await screen.findAllByText("Edit"))[0]);
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Finance (updated)" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith("cat_1", {
        name: "Finance (updated)",
        parentId: null,
        color: null,
        description: "",
        confidenceThreshold: 0.7,
        autoApply: true,
      }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["documents"] });
  });

  it("excludes the category being edited and its descendants from the parent picker", async () => {
    listMock.mockResolvedValueOnce([
      {
        id: "cat_1",
        name: "Finance",
        parentId: null,
        color: null,
        description: "",
        confidenceThreshold: 0.7,
        autoApply: true,
        sortOrder: 0,
        path: "Finance",
        documentCount: 0,
        createdAt: "",
        updatedAt: "",
      },
      {
        id: "cat_2",
        name: "Tax",
        parentId: "cat_1",
        color: null,
        description: "",
        confidenceThreshold: 0.7,
        autoApply: true,
        sortOrder: 0,
        path: "Finance / Tax",
        documentCount: 0,
        createdAt: "",
        updatedAt: "",
      },
      {
        id: "cat_3",
        name: "Personal",
        parentId: null,
        color: null,
        description: "",
        confidenceThreshold: 0.7,
        autoApply: true,
        sortOrder: 1,
        path: "Personal",
        documentCount: 0,
        createdAt: "",
        updatedAt: "",
      },
    ]);
    renderPage();
    fireEvent.click((await screen.findAllByText("Edit"))[0]);
    const dialog = within(screen.getByRole("dialog"));
    const select = dialog.getByLabelText("Parent") as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels).toContain("Personal");
    expect(optionLabels).not.toContain("Finance");
    expect(optionLabels).not.toContain("Finance / Tax");
  });

  it("shows the server's error message when creating a duplicate category fails", async () => {
    createMock.mockRejectedValueOnce(new ApiError({ code: "duplicate_name", message: 'A category named "Finance" already exists.', status: 409 }));
    renderPage();
    fireEvent.click(await screen.findByText("New category"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Finance" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A category named "Finance" already exists.'));
  });

  it("renders the description assistant and the color picker in the new category dialog", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("New category"));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("button", { name: "Draft with AI" })).toBeInTheDocument();
    expect(dialog.getByRole("group", { name: "Preset colors" })).toBeInTheDocument();
    expect(dialog.getByLabelText("Custom color")).toBeInTheDocument();
  });
});
