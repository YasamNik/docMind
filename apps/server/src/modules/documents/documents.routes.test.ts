import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";

let root: string;
let app: Awaited<ReturnType<typeof createTestApp>>["app"];
let cookie: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docmind-routes-"));
  const t = await createTestApp({ env: { DOCUMENT_STORAGE_ROOT: root } });
  app = t.app;
  cookie = (await t.signIn()).cookie;
});
afterEach(() => rm(root, { recursive: true, force: true }));

function upload(name: string, content: string, type = "text/plain") {
  return app.request(`/api/documents?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { cookie, "content-type": type, "content-length": String(Buffer.byteLength(content)) },
    body: content,
  });
}

describe("documents routes", () => {
  it("requires a session", async () => {
    expect((await app.request("/api/documents")).status).toBe(401);
  });

  it("uploads, lists, fetches, streams, renames, and deletes", async () => {
    const created = await upload("hello.txt", "hello world");
    expect(created.status).toBe(201);
    const { document } = await created.json();
    expect(document.name).toBe("hello.txt");

    const list = await (await app.request("/api/documents", { headers: { cookie } })).json();
    expect(list.documents.map((d: { id: string }) => d.id)).toEqual([document.id]);

    const file = await app.request(`/api/documents/${document.id}/file`, { headers: { cookie } });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toContain("text/plain");
    expect(file.headers.get("content-disposition")).toContain('inline; filename="hello.txt"');
    expect(await file.text()).toBe("hello world");

    const renamed = await app.request(`/api/documents/${document.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "renamed.txt" }),
    });
    expect((await renamed.json()).document.name).toBe("renamed.txt");

    expect((await app.request(`/api/documents/${document.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
    expect((await app.request(`/api/documents/${document.id}`, { headers: { cookie } })).status).toBe(404);
  });

  it("reports duplicates with 200 and duplicateOf", async () => {
    const first = await (await upload("a.txt", "same bytes")).json();
    const second = await upload("b.txt", "same bytes");
    expect(second.status).toBe(200);
    expect((await second.json()).duplicateOf).toBe(first.document.id);
  });

  it("rejects a missing name and an oversized upload before reading", async () => {
    const noName = await app.request("/api/documents", { method: "POST", headers: { cookie, "content-type": "text/plain" }, body: "x" });
    expect(noName.status).toBe(400);
    const big = await app.request("/api/documents?name=big.bin", {
      method: "POST",
      headers: { cookie, "content-type": "application/octet-stream", "content-length": String(200 * 1024 * 1024) },
      body: "not actually big",
    });
    expect(big.status).toBe(413);
  });
});
