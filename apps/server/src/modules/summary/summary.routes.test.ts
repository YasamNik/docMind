import { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";

let t: Awaited<ReturnType<typeof createTestApp>>;
let cookie: string;
let userId: string;

beforeEach(async () => {
  t = await createTestApp();
  ({ cookie, userId } = await t.signIn());
});

describe("summary routes", () => {
  it("requires a session", async () => {
    expect((await t.app.request("/api/documents/doc_0000000000000000/accept-title", { method: "POST" })).status).toBe(401);
  });

  it("accepts the suggested title over HTTP", async () => {
    const { document } = await t.services.documentsService.upload({
      userId,
      name: "notes.txt",
      mimeType: "text/plain",
      body: Readable.from(["hello"]),
    });
    await t.db.run(sql`update documents set suggested_title = 'Better Name' where id = ${document.id}`);

    const res = await t.app.request(`/api/documents/${document.id}/accept-title`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { document: { name: string; suggestedTitle: string | null } };
    expect(body.document.name).toBe("Better Name");
    expect(body.document.suggestedTitle).toBeNull();
  });
});
