import { afterEach, describe, expect, it, vi } from "vitest";
import { documentsApi } from "./documents-api";

afterEach(() => vi.restoreAllMocks());

describe("documentsApi", () => {
  it("lists documents", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ documents: [{ id: "doc_1" }] }), { status: 200 }));
    expect(await documentsApi.list()).toEqual([{ id: "doc_1" }]);
  });

  it("uploads with the file name in the query and reports progress", async () => {
    const sent: { url?: string; method?: string; body?: unknown } = {};
    class FakeXhr {
      upload = { addEventListener: (_: string, cb: (e: ProgressEvent) => void) => setTimeout(() => cb({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent), 0) };
      status = 201;
      responseText = JSON.stringify({ document: { id: "doc_2", name: "a.txt" } });
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      open(method: string, url: string) {
        sent.method = method;
        sent.url = url;
      }
      setRequestHeader() {}
      send(body: unknown) {
        sent.body = body;
        setTimeout(() => this.onload?.(), 1);
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr as unknown as typeof XMLHttpRequest);
    const progress: number[] = [];
    const file = new File(["hello"], "a.txt", { type: "text/plain" });
    const result = await documentsApi.upload(file, (p) => progress.push(p));
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("/api/documents?name=a.txt");
    expect(sent.body).toBe(file);
    expect(result.document.id).toBe("doc_2");
    expect(progress).toContain(50);
    vi.unstubAllGlobals();
  });

  it("builds the query string from filters", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ documents: [] }), { status: 200 }));
    await documentsApi.list({ categoryId: "cat_1", tagId: "tag_1", view: "inbox" });
    expect(fetchSpy).toHaveBeenCalledWith("/api/documents?categoryId=cat_1&tagId=tag_1&view=inbox", expect.anything());
  });

  it("includes documentTypeId in the query string when set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ documents: [] }), { status: 200 }));
    await documentsApi.list({ documentTypeId: "dtype_1" });
    expect(fetchSpy).toHaveBeenCalledWith("/api/documents?documentTypeId=dtype_1", expect.anything());
  });

  it('omits view from the query string when it is "all" or absent', async () => {
    // A fresh Response per call: mockResolvedValue would hand back the same instance for
    // both calls below, and a Response body can only be read once.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ documents: [] }), { status: 200 }));
    await documentsApi.list({ view: "all" });
    await documentsApi.list();
    expect(fetchSpy).toHaveBeenNthCalledWith(1, "/api/documents", expect.anything());
    expect(fetchSpy).toHaveBeenNthCalledWith(2, "/api/documents", expect.anything());
  });

  describe("fileErrorCode", () => {
    it("returns null and cancels the body without reading it when the file loads fine", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      });
      const cancelSpy = vi.spyOn(stream, "cancel");
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { status: 200 }));

      expect(await documentsApi.fileErrorCode("doc_1")).toBeNull();
      expect(cancelSpy).toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledWith("/api/documents/doc_1/file", expect.objectContaining({ credentials: "include" }));
    });

    it("returns the error code from a failed fetch", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "storage.reauth_required", message: "Reconnect" } }), { status: 401 }),
      );

      expect(await documentsApi.fileErrorCode("doc_1")).toBe("storage.reauth_required");
    });

    it("returns null when a failed fetch has no parseable error body", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", { status: 500 }));

      expect(await documentsApi.fileErrorCode("doc_1")).toBeNull();
    });
  });
});
