import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";

let t: Awaited<ReturnType<typeof createTestApp>>;
let cookie: string;
let userId: string;

beforeEach(async () => {
  t = await createTestApp();
  ({ cookie, userId } = await t.signIn());
});

describe("storage routes", () => {
  it("requires a session", async () => {
    expect((await t.app.request("/api/storage/drivers")).status).toBe(401);
  });

  it("lists each driver with its guide, readiness and document count", async () => {
    await t.services.documentsService.upload({ userId, name: "one.txt", mimeType: "text/plain", body: Readable.from(["a"]) });

    const res = await t.app.request("/api/storage/drivers", { headers: { cookie } });
    const body = (await res.json()) as { drivers: { id: string; label: string; configured: boolean; documentCount: number; active: boolean; guide: { steps: unknown[] } }[] };

    expect(res.status).toBe(200);
    const local = body.drivers.find((d) => d.id === "local")!;
    expect(local).toMatchObject({ label: "Local filesystem", configured: true, documentCount: 1, active: true });
    expect(local.guide.steps.length).toBeGreaterThan(0);
  });

  it("runs a driver's health check on demand", async () => {
    const res = await t.app.request("/api/storage/drivers/local/test", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("rejects an unknown driver id before it reaches the registry", async () => {
    const res = await t.app.request("/api/storage/drivers/nope/test", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(400);
  });
});
