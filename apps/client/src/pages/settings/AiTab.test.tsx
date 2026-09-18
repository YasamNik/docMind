import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiTab } from "./AiTab";

afterEach(() => cleanup());

function provider(overrides: Record<string, unknown>) {
  return {
    adapter: "openai-compatible",
    defaultBaseUrl: "https://example.com",
    requiresKey: true,
    capabilities: { text: true, structured: true, embeddings: true, listModels: true },
    suggestedModels: {},
    enabled: false,
    keySet: false,
    baseUrl: { value: "https://example.com", source: "default" },
    ...overrides,
  };
}

const providersMock = vi.fn(async () => ({
  providers: [
    provider({
      id: "openrouter",
      label: "OpenRouter",
      guide: { title: "Set up OpenRouter", intro: "", steps: [], notes: [] },
      enabled: true,
      keySet: true,
      keyLastFour: "abcd",
    }),
    provider({
      id: "anthropic",
      label: "Anthropic",
      guide: { title: "Set up Anthropic", intro: "", steps: [], notes: [] },
      enabled: false,
      keySet: true,
      keyLastFour: "wxyz",
    }),
    provider({
      id: "openai",
      label: "OpenAI",
      guide: { title: "Set up OpenAI", intro: "", steps: [], notes: [] },
      enabled: false,
      keySet: false,
    }),
  ],
  slots: {
    rules: { value: "", source: "default" },
    chat: { value: "", source: "default" },
    embedding: { value: "", source: "default" },
  },
}));

vi.mock("@/lib/ai-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai-api")>("@/lib/ai-api");
  return {
    ...actual,
    aiApi: {
      providers: () => providersMock(),
      models: vi.fn(async () => ({ models: [] })),
    },
  };
});

const update = vi.fn(async (_updates: Record<string, unknown>) => [] as unknown[]);
vi.mock("@/lib/settings-api", () => ({
  settingsApi: { update: (updates: Record<string, unknown>) => update(updates) },
}));

function renderTab() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AiTab />
    </QueryClientProvider>,
  );
}

describe("AiTab", () => {
  it("renders only added providers: enabled, backward-compat key-set, but not neither", async () => {
    renderTab();

    expect(await screen.findByRole("button", { name: "OpenRouter" })).toBeInTheDocument();
    // Anthropic has no enabled flag but does have a key, so it still renders (backward compat).
    expect(screen.getByRole("button", { name: /Anthropic/ })).toBeInTheDocument();
    // OpenAI has neither enabled nor a key, so it does not render as a card.
    expect(screen.queryByRole("button", { name: /OpenAI/ })).not.toBeInTheDocument();
  });

  it("expands the first added provider by default and only one card at a time", async () => {
    renderTab();

    expect(await screen.findByText("Set up OpenRouter")).toBeInTheDocument();
    expect(screen.queryByText("Set up Anthropic")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Anthropic/ }));

    expect(await screen.findByText("Set up Anthropic")).toBeInTheDocument();
    expect(screen.queryByText("Set up OpenRouter")).not.toBeInTheDocument();
  });

  it("shows the empty state and hides the model slots providers when nothing is added", async () => {
    providersMock.mockResolvedValueOnce({
      providers: [
        provider({ id: "openrouter", label: "OpenRouter", guide: { title: "", intro: "", steps: [], notes: [] } }),
      ],
      slots: { rules: { value: "", source: "default" }, chat: { value: "", source: "default" }, embedding: { value: "", source: "default" } },
    });
    renderTab();

    expect(await screen.findByText(/Add at least one provider/)).toBeInTheDocument();
  });

  it("Add picker lists only not-yet-added providers, and adding one makes its card appear", async () => {
    renderTab();
    await screen.findByRole("button", { name: "OpenRouter" });

    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

    expect(screen.getByRole("button", { name: "OpenAI" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "OpenRouter" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Anthropic" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "OpenAI" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith({ "ai.openai.enabled": true }));
  });
});
