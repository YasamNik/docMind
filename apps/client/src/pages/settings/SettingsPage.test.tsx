import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";

afterEach(() => cleanup());

vi.mock("@/lib/ai-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai-api")>("@/lib/ai-api");
  return {
    ...actual,
    aiApi: {
      providers: vi.fn(async () => ({
        providers: [
          {
            id: "openrouter",
            label: "OpenRouter",
            adapter: "openai-compatible",
            defaultBaseUrl: "https://openrouter.ai/api/v1",
            requiresKey: true,
            capabilities: { text: true, structured: true, embeddings: true, listModels: true },
            suggestedModels: { rules: "google/gemini-2.0-flash-001", chat: "anthropic/claude-sonnet-4" },
            guide: { title: "Set up OpenRouter", intro: "Get started.", steps: [{ text: "Step 1" }], notes: [] },
            enabled: true,
            keySet: true,
            keyLastFour: "abcd",
            baseUrl: { value: "https://openrouter.ai/api/v1", source: "default" },
          },
        ],
        slots: {
          rules: { value: "", source: "default", suggestion: "openrouter://google/gemini-2.0-flash-001" },
          chat: { value: "", source: "default", suggestion: "openrouter://anthropic/claude-sonnet-4" },
          embedding: { value: "", source: "default" },
        },
      })),
      testProvider: vi.fn(async () => ({ ok: true, latencyMs: 42, message: "Connected." })),
      models: vi.fn(async () => ({ models: [] })),
    },
  };
});

vi.mock("@/lib/settings-api", () => ({
  settingsApi: {
    list: vi.fn(async () => [
      { key: "storage.activeDriver", value: "local", source: "default", secret: false, doc: "Active storage driver." },
      { key: "storage.local.root", value: "./documents", source: "default", secret: false, doc: "Storage root." },
    ]),
    update: vi.fn(async () => []),
  },
}));

describe("SettingsPage", () => {
  it("shows AI tab with a provider card and the key status", async () => {
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <SettingsPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    // Provider name shows up both as the card title and as an option in each of the
    // three model slot dropdowns below, so this scenario legitimately has more than
    // one match; assert presence rather than uniqueness.
    expect((await screen.findAllByText("OpenRouter")).length).toBeGreaterThan(0);
    expect(screen.getByText(/Set, ends in/)).toBeInTheDocument();
    expect(screen.getByText(/abcd/)).toBeInTheDocument();
  });

  it("shows model slot rows", async () => {
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <SettingsPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Rules (sorting)")).toBeInTheDocument();
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getByText("Embedding")).toBeInTheDocument();
  });
});
