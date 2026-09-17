import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DryRunPanel } from "./DryRunPanel";

afterEach(() => cleanup());

const listMock = vi.fn(async () => [{ id: "doc_1", name: "invoice.pdf" }]);
const dryRunMock = vi.fn(async (_input: unknown) => ({ matched: true, confidence: 0.8, reasoning: "Mentions rent.", wouldApply: true }));

vi.mock("@/lib/documents-api", () => ({ documentsApi: { list: () => listMock() } }));
vi.mock("@/lib/sort-api", () => ({ sortApi: { dryRun: (input: unknown) => dryRunMock(input) } }));

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DryRunPanel targetType="tag" name="Rent" description="Monthly rent" threshold={0.7} />
    </QueryClientProvider>,
  );
}

describe("DryRunPanel", () => {
  it("tests the current in-memory form values against a chosen document", async () => {
    renderPanel();
    // Wait for the documents query to resolve and populate the select options
    await screen.findByRole("option", { name: "invoice.pdf" });
    const select = screen.getByDisplayValue("Choose a document");
    fireEvent.change(select, { target: { value: "doc_1" } });
    fireEvent.click(screen.getByText("Test"));
    await waitFor(() =>
      expect(dryRunMock).toHaveBeenCalledWith({ documentId: "doc_1", targetType: "tag", name: "Rent", description: "Monthly rent", threshold: 0.7 }),
    );
    expect(await screen.findByText(/Would apply/)).toBeInTheDocument();
  });

  it("disables Test until a document is chosen", async () => {
    renderPanel();
    await screen.findByRole("option", { name: "invoice.pdf" });
    expect(screen.getByText("Test").closest("button")).toBeDisabled();
  });
});
