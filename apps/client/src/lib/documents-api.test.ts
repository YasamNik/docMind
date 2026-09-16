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
});
