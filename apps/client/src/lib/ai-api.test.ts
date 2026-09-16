import { afterEach, describe, expect, it, vi } from "vitest";
import { aiApi } from "./ai-api";

afterEach(() => vi.restoreAllMocks());

describe("aiApi", () => {
  it("fetches providers and slots", async () => {
    const body = { providers: [{ id: "openrouter" }], slots: { rules: { value: "" } } };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const result = await aiApi.providers();
    expect(result.providers[0]?.id).toBe("openrouter");
  });

  it("tests a provider", async () => {
    const body = { ok: true, latencyMs: 100, message: "Connected." };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const result = await aiApi.testProvider("openrouter");
    expect(result.ok).toBe(true);
    expect(spy.mock.calls[0]?.[0]).toBe("/api/ai/providers/openrouter/test");
  });

  it("fetches models for a provider", async () => {
    const body = { models: [{ id: "model-1", label: "Model 1" }] };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const result = await aiApi.models("openrouter");
    expect(result.models[0]?.id).toBe("model-1");
  });
});
