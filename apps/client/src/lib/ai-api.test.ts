import { afterEach, describe, expect, it, vi } from "vitest";
import { aiApi, isProviderAdded, type ProviderInfo } from "./ai-api";

afterEach(() => vi.restoreAllMocks());

function provider(overrides: Partial<ProviderInfo>): ProviderInfo {
  return {
    id: "openrouter",
    label: "OpenRouter",
    adapter: "openai-compatible",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    requiresKey: true,
    capabilities: { text: true, structured: true, embeddings: true, listModels: true },
    suggestedModels: {},
    guide: { title: "", intro: "", steps: [], notes: [] },
    enabled: false,
    keySet: false,
    baseUrl: { value: "https://openrouter.ai/api/v1", source: "default" },
    ...overrides,
  };
}

describe("isProviderAdded", () => {
  it("is false when neither enabled nor a key is set", () => {
    expect(isProviderAdded(provider({ enabled: false, keySet: false }))).toBe(false);
  });

  it("is true when enabled", () => {
    expect(isProviderAdded(provider({ enabled: true, keySet: false }))).toBe(true);
  });

  it("is true when a model slot still points at it, which is the only signal a keyless provider has", () => {
    // Ollama and LM Studio need no key, so keySet is always false for them. Without the
    // slot clause a setup made before the enabled flag existed would vanish off the page
    // and out of the slot dropdown while the slot still pointed at it.
    const ollama = provider({ id: "ollama", requiresKey: false, enabled: false, keySet: false });
    const slots = { rules: { value: "ollama://llama3", source: "user" } };
    expect(isProviderAdded(ollama, slots)).toBe(true);
    expect(isProviderAdded(ollama)).toBe(false);
  });

  it("is not fooled by a slot pointing at a different provider", () => {
    const ollama = provider({ id: "ollama", requiresKey: false, enabled: false, keySet: false });
    expect(isProviderAdded(ollama, { rules: { value: "openrouter://gpt-4", source: "user" } })).toBe(false);
  });

  it("is false when a slot is empty", () => {
    const ollama = provider({ id: "ollama", requiresKey: false, enabled: false, keySet: false });
    expect(isProviderAdded(ollama, { rules: { value: "", source: "default" } })).toBe(false);
  });

  it("is true when a key is set, even without the enabled flag (backward compatibility)", () => {
    expect(isProviderAdded(provider({ enabled: false, keySet: true }))).toBe(true);
  });
});

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
