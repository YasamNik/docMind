import { describe, expect, it } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";
import { DEFAULT_INSTRUCTIONS, MAX_INSTRUCTIONS_CHARS, WARN_INSTRUCTIONS_CHARS } from "./assistant.models.js";

async function setup() {
  const t = await createTestApp();
  const { cookie, userId } = await t.signIn();
  return { t, cookie, userId };
}

const jsonHeaders = (cookie: string) => ({ cookie, "content-type": "application/json" });

describe("assistant instructions routes", () => {
  it("rejects an unauthenticated request", async () => {
    const { app } = await createTestApp();
    const jsonBody = { "content-type": "application/json" };

    expect((await app.request("/api/assistant/instructions")).status).toBe(401);
    expect(
      (await app.request("/api/assistant/instructions", { method: "PUT", headers: jsonBody, body: JSON.stringify({ body: "hi" }) })).status,
    ).toBe(401);
    expect(
      (
        await app.request("/api/assistant/instructions/restore", {
          method: "POST",
          headers: jsonBody,
          body: JSON.stringify({ replacedAt: "2026-09-19T00:00:00.000Z" }),
        })
      ).status,
    ).toBe(401);
  });

  it("returns the shipped default, the caps and an empty history", async () => {
    const { t, cookie } = await setup();

    const res = await t.app.request("/api/assistant/instructions", { headers: { cookie } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.body).toBe(DEFAULT_INSTRUCTIONS);
    expect(body.source).toBe("default");
    expect(body.maxChars).toBe(MAX_INSTRUCTIONS_CHARS);
    expect(body.warnChars).toBe(WARN_INSTRUCTIONS_CHARS);
    expect(body.shippedDefault).toBe(DEFAULT_INSTRUCTIONS);
    expect(body.history).toEqual([]);
  });

  it("saves a document and returns the new view with the old one in the history", async () => {
    const { t, cookie } = await setup();

    const res = await t.app.request("/api/assistant/instructions", {
      method: "PUT",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ body: "Keep replies short." }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.body).toBe("Keep replies short.");
    expect(body.source).toBe("db");
    expect(body.shippedDefault).toBe(DEFAULT_INSTRUCTIONS);
    expect(body.history).toHaveLength(1);
    expect(body.history[0].body).toBe(DEFAULT_INSTRUCTIONS);
  });

  it("refuses a document over the cap with 400 and a sentence naming the limit", async () => {
    const { t, cookie } = await setup();

    const res = await t.app.request("/api/assistant/instructions", {
      method: "PUT",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ body: "x".repeat(MAX_INSTRUCTIONS_CHARS + 1) }),
    });

    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error.code).toBe("assistant.instructions_too_long");
    expect(payload.error.message).toContain(String(MAX_INSTRUCTIONS_CHARS));
  });

  it("restores a version by its timestamp", async () => {
    const { t, cookie } = await setup();
    await t.app.request("/api/assistant/instructions", {
      method: "PUT",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ body: "First version." }),
    });
    const afterSecondSave = await (
      await t.app.request("/api/assistant/instructions", {
        method: "PUT",
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ body: "Second version." }),
      })
    ).json();
    const firstVersion = afterSecondSave.history.find((v: { body: string }) => v.body === "First version.");
    expect(firstVersion).toBeDefined();

    const res = await t.app.request("/api/assistant/instructions/restore", {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ replacedAt: firstVersion.replacedAt }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.body).toBe("First version.");
    expect(body.history.some((v: { body: string }) => v.body === "Second version.")).toBe(true);
  });

  it("returns 404 for a version that is not in the history", async () => {
    const { t, cookie } = await setup();

    const res = await t.app.request("/api/assistant/instructions/restore", {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ replacedAt: "2020-01-01T00:00:00.000Z" }),
    });

    expect(res.status).toBe(404);
    const payload = await res.json();
    expect(payload.error.code).toBe("assistant.instruction_version_not_found");
  });

  it("refuses to write the document through the settings API", async () => {
    const { t, cookie } = await setup();

    const res = await t.app.request("/api/settings", {
      method: "PUT",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ updates: { "assistant.instructions": "Sneaking in." } }),
    });

    expect(res.status).toBe(403);
    const payload = await res.json();
    expect(payload.error.code).toBe("settings.internal_only");
  });

  it("does not list the document in GET /api/settings", async () => {
    const { t, cookie } = await setup();

    const res = await t.app.request("/api/settings", { headers: { cookie } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.some((s: { key: string }) => s.key === "assistant.instructions")).toBe(false);
    expect(body.settings.some((s: { key: string }) => s.key === "assistant.instructionsHistory")).toBe(false);
  });
});
