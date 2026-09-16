import { describe, expect, it } from "vitest";
import { createTestApp } from "./shared/test/app.test-utils.js";

describe("server composition", () => {
  it("serves health without a session and settings only with one", async () => {
    const { app, signIn } = await createTestApp();
    expect((await app.request("/api/health")).status).toBe(200);
    expect((await app.request("/api/settings")).status).toBe(401);
    const { cookie } = await signIn();
    const res = await app.request("/api/settings", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.map((s: { key: string }) => s.key)).toContain("storage.activeDriver");
  });
});
