import { describe, expect, it, vi, beforeEach } from "vitest";
import { createTestApp } from "../../shared/test/app.test-utils.js";

// Stub fetch so adapter calls never hit the network.
const mockFetch = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.restoreAllMocks();
  mockFetch.mockReset();
  // Default: return a minimal models response so testConnection works
  mockFetch.mockResolvedValue(
    new Response(JSON.stringify({ data: [{ id: "test-model", name: "Test" }] }), { status: 200, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", mockFetch);
});

describe("ai routes", () => {
  it("GET /api/ai/providers returns providers and slots", async () => {
    const { app, signIn } = await createTestApp();
    const { cookie } = await signIn();
    const res = await app.request("/api/ai/providers", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers).toBeInstanceOf(Array);
    expect(body.providers.length).toBe(8);
    expect(body.providers[0].id).toBe("openrouter");
    expect(body.providers[0].guide).toBeTruthy();
    expect(body.providers[0]).toHaveProperty("keySet");
    expect(body.slots).toMatchObject({
      rules: expect.objectContaining({ value: "", source: expect.any(String) }),
      chat: expect.objectContaining({ value: "", source: expect.any(String) }),
      embedding: expect.objectContaining({ value: "", source: expect.any(String) }),
    });
  });

  it("GET /api/ai/providers requires auth", async () => {
    const { app } = await createTestApp();
    const res = await app.request("/api/ai/providers");
    expect(res.status).toBe(401);
  });

  it("POST /api/ai/providers/:id/test tests a provider", async () => {
    const { app, signIn, services } = await createTestApp();
    const { cookie, userId } = await signIn();
    // Set a key so test can build an adapter (the fake adapter will be used)
    await services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-testkey1234" });
    const res = await app.request("/api/ai/providers/openrouter/test", {
      method: "POST",
      headers: { cookie },
    });
    // The response depends on whether the fake adapter succeeds or the real
    // adapter fails against a fake key. Since testConnection catches errors,
    // we just check the shape.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("ok");
    expect(body).toHaveProperty("latencyMs");
    expect(body).toHaveProperty("message");
  });

  it("GET /api/ai/providers/:id/models returns a model list or error", async () => {
    const { app, signIn } = await createTestApp();
    const { cookie } = await signIn();
    const res = await app.request("/api/ai/providers/openrouter/models", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("models");
    expect(body.models).toBeInstanceOf(Array);
  });

  it("rejects unknown provider id", async () => {
    const { app, signIn } = await createTestApp();
    const { cookie } = await signIn();
    const res = await app.request("/api/ai/providers/nope/test", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(400);
  });

  it("PUT /api/settings validates a slot write for missing key", async () => {
    const { app, signIn } = await createTestApp();
    const { cookie } = await signIn();
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ updates: { "ai.model.rules": "openrouter://some-model" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("ai.provider_not_configured");
  });

  it("PUT /api/settings accepts a slot when the key is set", async () => {
    const { app, signIn, services } = await createTestApp();
    const { cookie, userId } = await signIn();
    await services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-testkey1234" });
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ updates: { "ai.model.rules": "openrouter://google/gemini-2.0-flash-001" } }),
    });
    expect(res.status).toBe(200);
  });

  it("PUT /api/settings allows clearing a slot with empty string", async () => {
    const { app, signIn, services } = await createTestApp();
    const { cookie, userId } = await signIn();
    await services.settingsService.set(userId, { "ai.openrouter.apiKey": "sk-or-v1-testkey1234" });
    await services.settingsService.set(userId, { "ai.model.rules": "openrouter://some-model" });
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ updates: { "ai.model.rules": "" } }),
    });
    expect(res.status).toBe(200);
  });
});
