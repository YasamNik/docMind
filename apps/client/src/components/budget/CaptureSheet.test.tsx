import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { CaptureSheet } from "./CaptureSheet";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const uploadMock = vi.fn();
vi.mock("@/lib/documents-api", () => ({
  documentsApi: {
    upload: (file: File, onProgress: (p: number) => void) => uploadMock(file, onProgress),
    fileUrl: (id: string) => `/api/documents/${id}/file`,
  },
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
  // Uploads that a test does not resolve stay pending, the same way a real one would
  // while it is still in flight.
  uploadMock.mockImplementation(() => new Promise(() => {}));
  createReceiptMock.mockReset();
  sessionStorage.clear();
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

  it("uploads a photo as soon as it is taken, not at Save", async () => {
    uploadMock.mockResolvedValueOnce({ document: { id: "doc_1" } });
    openSheetWithOnePhoto();

    await waitFor(() => expect(uploadMock).toHaveBeenCalledWith(expect.objectContaining({ name: "page1.jpg" }), expect.any(Function)));
    expect(createReceiptMock).not.toHaveBeenCalled();
    // Once the upload resolves the pending note clears and Save no longer needs to wait.
    await waitFor(() => expect(screen.queryByText("Uploading...")).not.toBeInTheDocument());
  });

  it("groups several shots into one save, in order", async () => {
    uploadMock.mockResolvedValueOnce({ document: { id: "doc_1" } });
    const input = openSheetWithOnePhoto();
    await waitFor(() => expect(screen.queryByText("Uploading...")).not.toBeInTheDocument());

    uploadMock.mockResolvedValueOnce({ document: { id: "doc_2" } });
    fireEvent.change(input, { target: { files: [photo("page2.jpg")] } });
    await screen.findByText("Page 2");
    await waitFor(() => expect(screen.queryByText("Uploading...")).not.toBeInTheDocument());

    createReceiptMock.mockResolvedValueOnce({ receipt: { id: "brcpt_1" }, alreadyExisted: false });

    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(createReceiptMock).toHaveBeenCalledWith(["doc_1", "doc_2"]));
    expect(uploadMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: "page1.jpg" }), expect.any(Function));
    expect(uploadMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: "page2.jpg" }), expect.any(Function));
    // Save only ever posted the ids: no third upload call happened during Save.
    expect(uploadMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the staged receipt across a remount, the reload case", async () => {
    uploadMock.mockResolvedValueOnce({ document: { id: "doc_1" } });
    const { unmount } = render(<CaptureSheet onCreated={vi.fn()} />);
    const input = screen.getByLabelText("Scan receipt") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [photo("page1.jpg")] } });
    await waitFor(() => expect(screen.queryByText("Uploading...")).not.toBeInTheDocument());

    // A reload discards every in memory value: the component tree, the File, the blob
    // urls. Unmounting and mounting a fresh instance stands in for that.
    unmount();
    uploadMock.mockClear();

    render(<CaptureSheet onCreated={vi.fn()} />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Page 1")).toBeInTheDocument();
    // The restored page is already uploaded; nothing is re-sent.
    expect(uploadMock).not.toHaveBeenCalled();

    createReceiptMock.mockResolvedValueOnce({ receipt: { id: "brcpt_1" }, alreadyExisted: false });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(createReceiptMock).toHaveBeenCalledWith(["doc_1"]));
  });

  it("reports a failed upload and lets the user remove it", async () => {
    uploadMock.mockRejectedValueOnce(new Error("Upload failed"));
    openSheetWithOnePhoto();

    expect(await screen.findByText("Could not upload this page.")).toBeInTheDocument();
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.click(dialog.getByRole("button", { name: "Remove page 1" }));
    expect(screen.queryByText("Could not upload this page.")).not.toBeInTheDocument();
    expect(screen.queryByText("Page 1")).not.toBeInTheDocument();
  });

  it("retries a failed upload", async () => {
    uploadMock.mockRejectedValueOnce(new Error("Upload failed"));
    openSheetWithOnePhoto();
    await screen.findByText("Could not upload this page.");

    uploadMock.mockResolvedValueOnce({ document: { id: "doc_1" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.queryByText("Could not upload this page.")).not.toBeInTheDocument());
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" })).not.toBeDisabled();
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

    fireEvent.change(input, { target: { files: [photo("page11.jpg")] } });
    expect(screen.queryByText("Page 11")).not.toBeInTheDocument();
  });

  it("closes and clears the staged pages once the receipt is created", async () => {
    uploadMock.mockResolvedValueOnce({ document: { id: "doc_1" } });
    const onCreated = vi.fn();
    render(<CaptureSheet onCreated={onCreated} />);
    const input = screen.getByLabelText("Scan receipt") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [photo("page1.jpg")] } });
    await screen.findByRole("dialog");
    await waitFor(() => expect(screen.queryByText("Uploading...")).not.toBeInTheDocument());

    createReceiptMock.mockResolvedValueOnce({ receipt: { id: "brcpt_1" }, alreadyExisted: false });

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: "brcpt_1" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(sessionStorage.getItem("docmind.captureSheet.documentIds")).toBeNull();
  });

  it("tells the user when this receipt was already saved and hands back the existing one", async () => {
    uploadMock.mockResolvedValueOnce({ document: { id: "doc_1" } });
    const onCreated = vi.fn();
    render(<CaptureSheet onCreated={onCreated} />);
    const input = screen.getByLabelText("Scan receipt") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [photo("page1.jpg")] } });
    await screen.findByRole("dialog");
    await waitFor(() => expect(screen.queryByText("Uploading...")).not.toBeInTheDocument());

    createReceiptMock.mockResolvedValueOnce({ receipt: { id: "brcpt_existing" }, alreadyExisted: true });

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("You already saved this receipt."));
    expect(onCreated).toHaveBeenCalledWith({ id: "brcpt_existing" });
  });
});
