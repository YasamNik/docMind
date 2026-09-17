import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { TagsPage } from "./TagsPage";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const listMock = vi.fn(async () => [
  {
    id: "tag_1",
    name: "Rent",
    color: "#4f46e5",
    description: "Monthly rent",
    confidenceThreshold: 0.7,
    autoApply: true,
    documentCount: 2,
    createdAt: "",
    updatedAt: "",
  },
]);
const createMock = vi.fn(async (input: unknown) => ({ id: "tag_2", documentCount: 0, createdAt: "", updatedAt: "", ...(input as object) }));
const removeMock = vi.fn(async (_id: string) => undefined);
const updateMock = vi.fn(async (id: string, patch: unknown) => ({ id, ...(patch as object) }));

vi.mock("@/lib/tags-api", () => ({
  tagsApi: {
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
      <TagsPage />
    </QueryClientProvider>,
  );
  return { invalidateSpy };
}

describe("TagsPage", () => {
  it("lists existing tags with their document count", async () => {
    renderPage();
    expect(await screen.findByText("Rent")).toBeInTheDocument();
    expect(screen.getByText("2 documents")).toBeInTheDocument();
  });

  it("creates a new tag", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("New tag"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Bills" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ name: "Bills" })));
  });

  it("deletes a tag after confirming and refreshes the documents query", async () => {
    const { invalidateSpy } = renderPage();
    fireEvent.click(await screen.findByText("Delete"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("tag_1"));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["documents"] });
  });

  it("edits a tag and saves the change", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("Edit"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Rent (updated)" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith("tag_1", {
        name: "Rent (updated)",
        color: "#4f46e5",
        description: "Monthly rent",
        confidenceThreshold: 0.7,
        autoApply: true,
      }),
    );
  });

  it("shows the server's error message when creating a duplicate tag fails", async () => {
    createMock.mockRejectedValueOnce(new ApiError({ code: "duplicate_name", message: 'A tag named "Rent" already exists.', status: 409 }));
    renderPage();
    fireEvent.click(await screen.findByText("New tag"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Rent" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A tag named "Rent" already exists.'));
  });
});
