import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("app", () => {
  it("answers the health check", async () => {
    const app = createApp();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
