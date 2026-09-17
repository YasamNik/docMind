import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TagsPage } from "./TagsPage";

afterEach(() => cleanup());

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

vi.mock("@/lib/tags-api", () => ({
  tagsApi: {
    list: () => listMock(),
    create: (input: unknown) => createMock(input),
    update: vi.fn(async (id: string, patch: unknown) => ({ id, ...(patch as object) })),
    remove: (id: string) => removeMock(id),
  },
}));

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TagsPage />
    </QueryClientProvider>,
  );
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

  it("deletes a tag after confirming", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("Delete"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("tag_1"));
  });
});
