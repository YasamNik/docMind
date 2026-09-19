import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { TypesPage } from "./TypesPage";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const listMock = vi.fn(async () => [
  {
    id: "dtype_1",
    name: "Invoice",
    color: "#4f46e5",
    description: "A request for payment for goods or work.",
    confidenceThreshold: 0.7,
    autoApply: true,
    documentCount: 3,
    createdAt: "",
    updatedAt: "",
  },
]);
const createMock = vi.fn(async (input: unknown) => ({ id: "dtype_2", documentCount: 0, createdAt: "", updatedAt: "", ...(input as object) }));
const removeMock = vi.fn(async (_id: string) => undefined);
const updateMock = vi.fn(async (id: string, patch: unknown) => ({ id, ...(patch as object) }));

vi.mock("@/lib/documents-api", () => ({ documentsApi: { list: vi.fn(async () => [{ id: "doc_1", name: "invoice.pdf" }]) } }));
vi.mock("@/lib/sort-api", () => ({ sortApi: { dryRun: vi.fn(async () => ({ matched: false, confidence: 0, reasoning: "", wouldApply: false })) } }));

vi.mock("@/lib/types-api", () => ({
  typesApi: {
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
      <TypesPage />
    </QueryClientProvider>,
  );
  return { invalidateSpy };
}

describe("TypesPage", () => {
  it("lists existing types with their document count", async () => {
    renderPage();
    expect(await screen.findByText("Invoice")).toBeInTheDocument();
    expect(screen.getByText("3 documents")).toBeInTheDocument();
  });

  it("creates a new type", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("New type"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Receipt" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ name: "Receipt" })));
  });

  it("deletes a type after confirming and refreshes the documents query", async () => {
    const { invalidateSpy } = renderPage();
    fireEvent.click(await screen.findByText("Delete"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("dtype_1"));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["documents"] });
  });

  it("edits a type and saves the change", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("Edit"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Invoice (updated)" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith("dtype_1", {
        name: "Invoice (updated)",
        color: "#4f46e5",
        description: "A request for payment for goods or work.",
        confidenceThreshold: 0.7,
        autoApply: true,
      }),
    );
  });

  it("shows the server's error message when creating a duplicate type fails", async () => {
    createMock.mockRejectedValueOnce(new ApiError({ code: "duplicate_name", message: 'A type named "Invoice" already exists.', status: 409 }));
    renderPage();
    fireEvent.click(await screen.findByText("New type"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Invoice" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A type named "Invoice" already exists.'));
  });

  it("renders the description assistant and the color picker in the new type dialog", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("New type"));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("button", { name: "Draft with AI" })).toBeInTheDocument();
    expect(dialog.getByRole("group", { name: "Preset colors" })).toBeInTheDocument();
    expect(dialog.getByLabelText("Custom color")).toBeInTheDocument();
  });

  it("reads Improve with AI in the edit dialog since the type already has a description", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("Edit"));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("button", { name: "Improve with AI" })).toBeInTheDocument();
  });
});
