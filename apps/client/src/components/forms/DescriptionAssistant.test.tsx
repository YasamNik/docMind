import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DescriptionAssistant } from "./DescriptionAssistant";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const suggestMock = vi.fn(async (_input: unknown) => ({ suggestion: "A tighter description for the sorter." }));

vi.mock("@/lib/description-assistant-api", () => ({
  descriptionAssistantApi: { suggest: (input: unknown) => suggestMock(input) },
}));

function renderAssistant(props: Partial<Parameters<typeof DescriptionAssistant>[0]> = {}) {
  const onUse = vi.fn();
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <DescriptionAssistant targetType="tag" name="Medical" description="" onUse={onUse} {...props} />
    </QueryClientProvider>,
  );
  return { onUse };
}

describe("DescriptionAssistant", () => {
  it('reads "Draft with AI" when the description is empty', () => {
    renderAssistant({ description: "" });
    expect(screen.getByRole("button", { name: "Draft with AI" })).toBeInTheDocument();
  });

  it('reads "Improve with AI" when the description has text', () => {
    renderAssistant({ description: "doctor visits" });
    expect(screen.getByRole("button", { name: "Improve with AI" })).toBeInTheDocument();
  });

  it("shows the suggestion without changing the field until Use it is clicked", async () => {
    const { onUse } = renderAssistant({ description: "doctor visits" });
    fireEvent.click(screen.getByRole("button", { name: "Improve with AI" }));
    expect(await screen.findByText("A tighter description for the sorter.")).toBeInTheDocument();
    expect(onUse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use it" }));
    expect(onUse).toHaveBeenCalledWith("A tighter description for the sorter.");
  });

  it("dismiss leaves the original text intact and discards the suggestion", async () => {
    const { onUse } = renderAssistant({ description: "doctor visits" });
    fireEvent.click(screen.getByRole("button", { name: "Improve with AI" }));
    await screen.findByText("A tighter description for the sorter.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onUse).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("A tighter description for the sorter.")).not.toBeInTheDocument());
  });

  it("replaces the shown suggestion on a second request and still leaves the field alone", async () => {
    const { onUse } = renderAssistant({ description: "doctor visits" });
    fireEvent.click(screen.getByRole("button", { name: "Improve with AI" }));
    await screen.findByText("A tighter description for the sorter.");

    suggestMock.mockResolvedValueOnce({ suggestion: "A second, different suggestion." });
    fireEvent.click(screen.getByRole("button", { name: "Improve with AI" }));

    expect(await screen.findByText("A second, different suggestion.")).toBeInTheDocument();
    // Only one suggestion is ever on screen, and neither request touched the field.
    await waitFor(() => expect(screen.queryByText("A tighter description for the sorter.")).not.toBeInTheDocument());
    expect(onUse).not.toHaveBeenCalled();
  });

  it("calls the API with the target type, name, and current description", async () => {
    renderAssistant({ targetType: "category", name: "Tax", description: "invoices" });
    fireEvent.click(screen.getByRole("button", { name: "Improve with AI" }));
    await waitFor(() => expect(suggestMock).toHaveBeenCalledWith({ targetType: "category", name: "Tax", description: "invoices" }));
  });
});
