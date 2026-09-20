import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { CaptureSheet } from "./CaptureSheet";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const uploadMock = vi.fn();
vi.mock("@/lib/documents-api", () => ({
  documentsApi: { upload: (file: File, onProgress: (p: number) => void) => uploadMock(file, onProgress) },
}));

const createReceiptMock = vi.fn();
vi.mock("@/lib/budget-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/budget-api")>("@/lib/budget-api");
  return { ...actual, budgetApi: { createReceipt: (ids: string[]) => createReceiptMock(ids) } };
});

beforeEach(() => {
  // jsdom does not implement createObjectURL; the sheet only needs a stable string back
  // to key and preview each staged photo by.
  let counter = 0;
  window.URL.createObjectURL = vi.fn(() => `blob:mock-${counter++}`);
  window.URL.revokeObjectURL = vi.fn();
  uploadMock.mockReset();
  createReceiptMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function photo(name: string) {
  return new File(["x"], name, { type: "image/jpeg" });
}

function openSheetWithOnePhoto() {
  render(<CaptureSheet onCreated={vi.fn()} />);
  const input = screen.getByLabelText("Scan receipt") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [photo("page1.jpg")] } });
  return input;
}

describe("CaptureSheet", () => {
  it("stages a photo and opens the sheet once one is taken", async () => {
    openSheetWithOnePhoto();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Page 1")).toBeInTheDocument();
  });

  it("groups several shots into one save, in order", async () => {
    const input = openSheetWithOnePhoto();
    fireEvent.change(input, { target: { files: [photo("page2.jpg")] } });
    expect(await screen.findByText("Page 2")).toBeInTheDocument();

    uploadMock.mockResolvedValueOnce({ document: { id: "doc_1" } }).mockResolvedValueOnce({ document: { id: "doc_2" } });
    createReceiptMock.mockResolvedValueOnce({ receipt: { id: "brcpt_1" }, alreadyExisted: false });

    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(createReceiptMock).toHaveBeenCalledWith(["doc_1", "doc_2"]));
    expect(uploadMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: "page1.jpg" }), expect.any(Function));
    expect(uploadMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: "page2.jpg" }), expect.any(Function));
  });

  it("removes a staged page before saving", async () => {
    const input = openSheetWithOnePhoto();
    fireEvent.change(input, { target: { files: [photo("page2.jpg")] } });
    await screen.findByText("Page 2");

    fireEvent.click(screen.getByRole("button", { name: "Remove page 1" }));
    expect(screen.queryByText("Page 2")).not.toBeInTheDocument();
    expect(screen.getByText("Page 1")).toBeInTheDocument();
  });

  it("disables Add another page at ten photos", async () => {
    const input = openSheetWithOnePhoto();
    for (let i = 2; i <= 10; i += 1) {
      fireEvent.change(input, { target: { files: [photo(`page${i}.jpg`)] } });
    }
    await screen.findByText("Page 10");
    expect(screen.getByRole("button", { name: "Add another page" })).toBeDisabled();
  });

  it("closes and clears the staged pages once the receipt is created", async () => {
    const onCreated = vi.fn();
    render(<CaptureSheet onCreated={onCreated} />);
    const input = screen.getByLabelText("Scan receipt") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [photo("page1.jpg")] } });
    await screen.findByRole("dialog");

    uploadMock.mockResolvedValueOnce({ document: { id: "doc_1" } });
    createReceiptMock.mockResolvedValueOnce({ receipt: { id: "brcpt_1" }, alreadyExisted: false });

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: "brcpt_1" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("tells the user when this receipt was already saved and hands back the existing one", async () => {
    const onCreated = vi.fn();
    render(<CaptureSheet onCreated={onCreated} />);
    const input = screen.getByLabelText("Scan receipt") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [photo("page1.jpg")] } });
    await screen.findByRole("dialog");

    uploadMock.mockResolvedValueOnce({ document: { id: "doc_1" } });
    createReceiptMock.mockResolvedValueOnce({ receipt: { id: "brcpt_existing" }, alreadyExisted: true });

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("You already saved this receipt."));
    expect(onCreated).toHaveBeenCalledWith({ id: "brcpt_existing" });
  });
});
