import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    keySet: false,
    baseUrl: { value: "https://example.com", source: "default" },
    ...overrides,
  };
}

vi.mock("@/lib/ai-api", () => ({
  aiApi: {
    providers: vi.fn(async () => ({
      providers: [
        provider({ id: "openrouter", label: "OpenRouter", guide: { title: "Set up OpenRouter", intro: "", steps: [], notes: [] }, keySet: true, keyLastFour: "abcd" }),
        provider({ id: "openai", label: "OpenAI", guide: { title: "Set up OpenAI", intro: "", steps: [], notes: [] } }),
      ],
      slots: {
        rules: { value: "", source: "default" },
        chat: { value: "", source: "default" },
        embedding: { value: "", source: "default" },
      },
    })),
    models: vi.fn(async () => ({ models: [] })),
  },
}));

vi.mock("@/lib/settings-api", () => ({
  settingsApi: { update: vi.fn(async () => []) },
}));

describe("AiTab", () => {
  it("expands the first provider by default and only one card at a time", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AiTab />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Set up OpenRouter")).toBeInTheDocument();
    expect(screen.queryByText("Set up OpenAI")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /OpenAI/ }));

    expect(await screen.findByText("Set up OpenAI")).toBeInTheDocument();
    expect(screen.queryByText("Set up OpenRouter")).not.toBeInTheDocument();
  });
});
