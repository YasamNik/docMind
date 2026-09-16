import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadDropzone } from "./UploadDropzone";

// Testing Library's automatic afterEach cleanup only registers when it finds a
// global afterEach; this project's vitest config does not enable test globals,
// so unmount each render explicitly to remove the document paste listener too.
afterEach(() => cleanup());

vi.mock("@/lib/documents-api", () => ({
  documentsApi: {
    upload: vi.fn(async (file: File, onProgress: (p: number) => void) => {
      onProgress(100);
      return { document: { id: "doc_1", name: file.name } };
    }),
  },
}));

type ClipboardItemLike = { kind: string; type: string; file: File | null };

function makeClipboardData(opts: { items?: ClipboardItemLike[]; text?: string }) {
  const items = opts.items ?? [];
  return {
    items: items.map((it) => ({
      kind: it.kind,
      type: it.type,
      getAsFile: () => it.file,
    })),
    files: items.filter((it) => it.file).map((it) => it.file) as File[],
    getData: (type: string) => (type === "text/plain" ? (opts.text ?? "") : ""),
  };
}

function dispatchPaste(target: EventTarget, clipboardData: unknown) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: clipboardData });
  target.dispatchEvent(event);
  return event;
}

describe("UploadDropzone", () => {
  it("uploads a picked file and reports it", async () => {
    const onUploaded = vi.fn();
    render(<UploadDropzone onUploaded={onUploaded} />);
    const input = screen.getByLabelText(/choose files/i) as HTMLInputElement;
    const file = new File(["x"], "pick.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ document: expect.objectContaining({ name: "pick.txt" }) })));
  });

  it("uploads pasted plain text as a named text file", async () => {
    const onUploaded = vi.fn();
    render(<UploadDropzone onUploaded={onUploaded} />);
    dispatchPaste(document, makeClipboardData({ text: "hello clipboard" }));
    await waitFor(() =>
      expect(onUploaded).toHaveBeenCalledWith(
        expect.objectContaining({ document: expect.objectContaining({ name: expect.stringMatching(/^Pasted text .*\.txt$/) }) }),
      ),
    );
  });

  it("uploads a pasted image file item", async () => {
    const onUploaded = vi.fn();
    render(<UploadDropzone onUploaded={onUploaded} />);
    const file = new File(["x"], "image.png", { type: "image/png" });
    dispatchPaste(document, makeClipboardData({ items: [{ kind: "file", type: "image/png", file }] }));
    await waitFor(() =>
      expect(onUploaded).toHaveBeenCalledWith(
        expect.objectContaining({ document: expect.objectContaining({ name: expect.stringMatching(/^Pasted image .*\.png$/) }) }),
      ),
    );
  });

  it("ignores a paste whose target is an input on the page", async () => {
    const onUploaded = vi.fn();
    render(
      <div>
        <UploadDropzone onUploaded={onUploaded} />
        <input aria-label="notes" />
      </div>,
    );
    const notesInput = screen.getByLabelText("notes");
    dispatchPaste(notesInput, makeClipboardData({ text: "hello clipboard" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("removes the paste listener on unmount", async () => {
    const onUploaded = vi.fn();
    const { unmount } = render(<UploadDropzone onUploaded={onUploaded} />);
    unmount();
    dispatchPaste(document, makeClipboardData({ text: "hello clipboard" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onUploaded).not.toHaveBeenCalled();
  });
});
