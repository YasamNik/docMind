import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderCard } from "./ProviderCard";
import type { ProviderInfo } from "@/lib/ai-api";

afterEach(() => cleanup());

const testProvider = vi.fn(async (_id: string) => ({ ok: true, latencyMs: 42, message: "Connected." }));
const update = vi.fn(async (_updates: Record<string, unknown>) => [] as unknown[]);

vi.mock("@/lib/ai-api", () => ({
  aiApi: {
    testProvider: (id: string) => testProvider(id),
  },
}));

vi.mock("@/lib/settings-api", () => ({
  settingsApi: {
    update: (updates: Record<string, unknown>) => update(updates),
  },
}));

function baseProvider(overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: "openrouter",
    label: "OpenRouter",
    adapter: "openai-compatible",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    requiresKey: true,
    capabilities: { text: true, structured: true, embeddings: true, listModels: true },
    suggestedModels: {},
    guide: { title: "Set up OpenRouter", intro: "Get started.", steps: [], notes: [] },
    enabled: true,
    keySet: false,
    baseUrl: { value: "https://openrouter.ai/api/v1", source: "default" },
    ...overrides,
  };
}

function renderCard(
  provider: ProviderInfo,
  expanded = true,
  slots: Record<string, { value: string; source: string }> = {},
) {
  const onExpand = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProviderCard provider={provider} expanded={expanded} onExpand={onExpand} slots={slots} />
    </QueryClientProvider>,
  );
  return { onExpand };
}

describe("ProviderCard", () => {
  it("shows the unset-key state with a Save flow and no Replace or Clear actions", () => {
    renderCard(baseProvider({ keySet: false }));
    expect(screen.getByPlaceholderText("Paste your API key")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Replace" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows the from environment badge for the base URL when its source is env", () => {
    renderCard(baseProvider({ baseUrl: { value: "https://example.com", source: "env" } }));
    expect(screen.getByText("from environment")).toBeInTheDocument();
  });

  it("shows the test result inline on success", async () => {
    testProvider.mockResolvedValueOnce({ ok: true, latencyMs: 42, message: "Connected." });
    renderCard(baseProvider({ keySet: true, keyLastFour: "abcd" }));
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("OK (42ms)")).toBeInTheDocument();
  });

  it("shows the test result inline on failure", async () => {
    testProvider.mockResolvedValueOnce({ ok: false, latencyMs: 0, message: "Invalid API key." });
    renderCard(baseProvider({ keySet: true, keyLastFour: "abcd" }));
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("Invalid API key.")).toBeInTheDocument();
  });

  it("collapses to a summary row and calls onExpand when clicked", () => {
    const { onExpand } = renderCard(baseProvider({ keySet: true, keyLastFour: "abcd" }), false);
    expect(screen.queryByText("Set up OpenRouter")).not.toBeInTheDocument();
    expect(screen.getByText(/Key set, ends in/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /OpenRouter/ }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("blocks removal while a model slot references the provider and names the slot", () => {
    renderCard(baseProvider({ keySet: true, keyLastFour: "abcd" }), true, {
      chat: { value: "openrouter://gpt-4", source: "db" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText(/Chat/)).toBeInTheDocument();
    // The dialog offers no destructive confirm action while blocked.
    expect(screen.queryByRole("button", { name: "Remove provider" })).not.toBeInTheDocument();
  });

  it("clears the key after confirming removal", async () => {
    renderCard(baseProvider({ keySet: true, keyLastFour: "abcd" }), true, {});
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText(/cannot be recovered/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove provider" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        "ai.openrouter.enabled": false,
        "ai.openrouter.apiKey": null,
      }),
    );
  });
});
