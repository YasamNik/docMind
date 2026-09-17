import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelSlotRow } from "./ModelSlotRow";
import type { ProviderInfo, SlotInfo } from "@/lib/ai-api";

afterEach(() => cleanup());

type ModelsResult = { models: { id: string; label: string }[]; error?: string };
const modelsMock = vi.fn(async (_id: string): Promise<ModelsResult> => ({ models: [] }));
const update = vi.fn(async (_updates: Record<string, unknown>) => [] as unknown[]);
const toastSuccess = vi.fn();

vi.mock("sonner", () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args), error: vi.fn() },
}));

vi.mock("@/lib/ai-api", () => ({
  aiApi: {
    models: (id: string) => modelsMock(id),
  },
}));

vi.mock("@/lib/settings-api", () => ({
  settingsApi: {
    update: (updates: Record<string, unknown>) => update(updates),
  },
}));

const providers: ProviderInfo[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    adapter: "openai-compatible",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    requiresKey: true,
    capabilities: { text: true, structured: true, embeddings: true, listModels: true },
    suggestedModels: {},
    guide: { title: "", intro: "", steps: [], notes: [] },
    keySet: true,
    baseUrl: { value: "https://openrouter.ai/api/v1", source: "default" },
  },
];

function renderRow(slotInfo: SlotInfo) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ModelSlotRow slot="chat" slotInfo={slotInfo} providers={providers} />
    </QueryClientProvider>,
  );
}

describe("ModelSlotRow", () => {
  it("saves the built provider://model value and toasts", async () => {
    modelsMock.mockResolvedValueOnce({ models: [] });
    renderRow({ value: "", source: "default" });
    const input = screen.getByPlaceholderText("Model name");
    fireEvent.change(input, { target: { value: "anthropic/claude-sonnet-4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ "ai.model.chat": "openrouter://anthropic/claude-sonnet-4" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Model saved"));
  });

  it("shows a loading hint while models are in flight", async () => {
    let resolveModels!: (value: { models: never[] }) => void;
    modelsMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveModels = resolve;
      }),
    );
    renderRow({ value: "", source: "default" });
    expect(await screen.findByText("Loading models...")).toBeInTheDocument();
    resolveModels({ models: [] });
    await waitFor(() => expect(screen.queryByText("Loading models...")).not.toBeInTheDocument());
  });

  it("shows the models route error under the input", async () => {
    modelsMock.mockResolvedValueOnce({ models: [], error: "Add an API key to list models." });
    renderRow({ value: "", source: "default" });
    expect(await screen.findByText("Add an API key to list models.")).toBeInTheDocument();
  });

  it("shows the vision slot label", () => {
    modelsMock.mockResolvedValueOnce({ models: [] });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ModelSlotRow slot="vision" slotInfo={{ value: "", source: "default" }} providers={providers} />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Vision (OCR fallback)")).toBeInTheDocument();
  });
});
