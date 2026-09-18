import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";

let root: string;
let t: Awaited<ReturnType<typeof createTestApp>>;
let cookie: string;
let userId: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docmind-triage-"));
  t = await createTestApp({ env: { DOCUMENT_STORAGE_ROOT: root } });
  const session = await t.signIn();
  cookie = session.cookie;
  userId = session.userId;
});
afterEach(() => rm(root, { recursive: true, force: true }));

function upload(name: string, content: string) {
  return t.app.request(`/api/documents?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { cookie, "content-type": "text/plain", "content-length": String(Buffer.byteLength(content)) },
    body: content,
  });
}

describe("inbox triage", () => {
  it("new documents have triageStatus pending and appear in inbox", async () => {
    const created = await (await upload("doc.txt", "hello")).json();
    expect(created.document.triageStatus).toBe("pending");

    const inbox = await (await t.app.request("/api/documents?view=inbox", { headers: { cookie } })).json();
    expect(inbox.documents).toHaveLength(1);
    expect(inbox.documents[0].id).toBe(created.document.id);
  });

  it("accepts a document and moves it out of inbox", async () => {
    const { document } = await (await upload("doc.txt", "hello")).json();

    const acceptRes = await t.app.request(`/api/documents/${document.id}/triage`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ action: "accept" }),
    });
    expect(acceptRes.status).toBe(200);
    const accepted = await acceptRes.json();
    expect(accepted.document.triageStatus).toBe("reviewed");

    const inbox = await (await t.app.request("/api/documents?view=inbox", { headers: { cookie } })).json();
    expect(inbox.documents).toHaveLength(0);
  });

  it("rejects accepting an already-reviewed document", async () => {
    const { document } = await (await upload("doc.txt", "hello")).json();
    await t.app.request(`/api/documents/${document.id}/triage`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ action: "accept" }),
    });

    const secondAccept = await t.app.request(`/api/documents/${document.id}/triage`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ action: "accept" }),
    });
    expect(secondAccept.status).toBe(400);
  });

  it("accepts with title when suggestedTitle exists", async () => {
    const { document } = await (await upload("doc.txt", "hello")).json();

    await t.db.run(sql`UPDATE documents SET suggested_title = ${"Better Title"} WHERE id = ${document.id}`);

    const acceptRes = await t.app.request(`/api/documents/${document.id}/triage`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ action: "accept", acceptTitle: true }),
    });
    const accepted = await acceptRes.json();
    expect(accepted.document.name).toBe("Better Title");
    expect(accepted.document.triageStatus).toBe("reviewed");
  });

  it("batch accepts multiple documents", async () => {
    const doc1 = await (await upload("a.txt", "one")).json();
    const doc2 = await (await upload("b.txt", "two")).json();
    const doc3 = await (await upload("c.txt", "three")).json();

    const batchRes = await t.app.request("/api/documents/triage", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ documentIds: [doc1.document.id, doc2.document.id, doc3.document.id], action: "accept" }),
    });
    expect(batchRes.status).toBe(200);
    const result = await batchRes.json();
    expect(result.updatedCount).toBe(3);

    const inbox = await (await t.app.request("/api/documents?view=inbox", { headers: { cookie } })).json();
    expect(inbox.documents).toHaveLength(0);
  });

  it("inbox count reflects triageStatus", async () => {
    await upload("a.txt", "one");
    await upload("b.txt", "two");

    let counts = await (await t.app.request("/api/documents/counts", { headers: { cookie } })).json();
    expect(counts.inbox).toBe(2);

    const docs = await (await t.app.request("/api/documents?view=inbox", { headers: { cookie } })).json();
    await t.app.request(`/api/documents/${docs.documents[0].id}/triage`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ action: "accept" }),
    });

    counts = await (await t.app.request("/api/documents/counts", { headers: { cookie } })).json();
    expect(counts.inbox).toBe(1);
  });
});
