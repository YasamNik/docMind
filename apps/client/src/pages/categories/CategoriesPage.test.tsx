import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { CategoriesPage } from "./CategoriesPage";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const listMock = vi.fn(async () => [
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

vi.mock("@/lib/tags-api", () => ({
  categoriesApi: {
    list: () => listMock(),
    create: (input: unknown) => createMock(input),
    update: (id: string, patch: unknown) => updateMock(id, patch),
    remove: (id: string) => removeMock(id),
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

  it("moves a category down by swapping sortOrder with its next sibling", async () => {
    renderPage();
    await screen.findByText("Finance");
    fireEvent.click(screen.getByLabelText("Move Finance down"));
    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledWith("cat_1", { sortOrder: 1 });
      expect(updateMock).toHaveBeenCalledWith("cat_2", { sortOrder: 0 });
    });
  });

  it("does nothing when moving the first category up", async () => {
    renderPage();
    await screen.findByText("Finance");
    fireEvent.click(screen.getByLabelText("Move Finance up"));
    expect(updateMock).not.toHaveBeenCalled();
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

  it("shows the server's error message when creating a duplicate category fails", async () => {
    createMock.mockRejectedValueOnce(new ApiError({ code: "duplicate_name", message: 'A category named "Finance" already exists.', status: 409 }));
    renderPage();
    fireEvent.click(await screen.findByText("New category"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Finance" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A category named "Finance" already exists.'));
  });
});
