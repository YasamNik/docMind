import { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";
import { createFieldsRepository } from "./fields.repository.js";

let t: Awaited<ReturnType<typeof createTestApp>>;
let cookie: string;
let userId: string;

beforeEach(async () => {
  t = await createTestApp();
  ({ cookie, userId } = await t.signIn());
});

async function uploadDoc(name = "doc.txt") {
  const { document } = await t.services.documentsService.upload({ userId, name, mimeType: "text/plain", body: Readable.from(["text"]) });
  return document.id;
}

describe("fields routes", () => {
  it("requires a session", async () => {
    expect((await t.app.request("/api/documents/doc_0000000000000000/fields")).status).toBe(401);
  });

  it("returns the fields for a document", async () => {
    const documentId = await uploadDoc();
    await createFieldsRepository({ db: t.db }).replaceForDocument({
      userId,
      documentId,
      fields: [{ key: "documentType", value: "invoice", valueNumber: null, valueDate: null, currency: null, confidence: 0.9 }],
    });

    const res = await t.app.request(`/api/documents/${documentId}/fields`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fields: { key: string; value: string }[] };
    expect(body.fields).toHaveLength(1);
    expect(body.fields[0]!.key).toBe("documentType");
    expect(body.fields[0]!.value).toBe("invoice");
  });

  it("refuses to return another user's fields", async () => {
    // DocMind is single-account: sign up closes after the first user, so a second HTTP
    // session cannot be created. This seeds a row under a different user id on the same
    // document, the way fields.repository.test.ts already proves isolation, and checks
    // the route only ever returns rows scoped to the requester's own user id.
    const documentId = await uploadDoc();
    await createFieldsRepository({ db: t.db }).replaceForDocument({
      userId: "someone-else",
      documentId,
      fields: [{ key: "counterparty", value: "Acme", valueNumber: null, valueDate: null, currency: null, confidence: null }],
    });

    const res = await t.app.request(`/api/documents/${documentId}/fields`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fields: unknown[] };
    expect(body.fields).toEqual([]);
  });

  it("lists distinct values for a key", async () => {
    const documentId = await uploadDoc();
    await createFieldsRepository({ db: t.db }).replaceForDocument({
      userId,
      documentId,
      fields: [{ key: "documentType", value: "invoice", valueNumber: null, valueDate: null, currency: null, confidence: null }],
    });

    const res = await t.app.request("/api/fields/values?key=documentType", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { values: string[] };
    expect(body.values).toEqual(["invoice"]);
  });

  it("rejects an unknown key on the values endpoint", async () => {
    const res = await t.app.request("/api/fields/values?key=notARealKey", { headers: { cookie } });
    expect(res.status).toBe(400);
  });

  it("starts a backfill and reports how many were enqueued", async () => {
    const documentId = await uploadDoc();
    await t.db.run(sql`update documents set extraction_status = 'done' where id = ${documentId}`);

    const res = await t.app.request("/api/fields/backfill", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enqueued: number; skipped: number };
    expect(body.enqueued).toBe(1);
    expect(body.skipped).toBe(0);
  });
});
