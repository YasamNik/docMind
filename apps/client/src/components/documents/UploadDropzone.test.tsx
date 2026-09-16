import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UploadDropzone } from "./UploadDropzone";

vi.mock("@/lib/documents-api", () => ({
  documentsApi: {
    upload: vi.fn(async (file: File, onProgress: (p: number) => void) => {
      onProgress(100);
      return { document: { id: "doc_1", name: file.name } };
    }),
  },
}));

describe("UploadDropzone", () => {
  it("uploads a picked file and reports it", async () => {
    const onUploaded = vi.fn();
    render(<UploadDropzone onUploaded={onUploaded} />);
    const input = screen.getByLabelText(/choose files/i) as HTMLInputElement;
    const file = new File(["x"], "pick.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ document: expect.objectContaining({ name: "pick.txt" }) })));
  });
});
