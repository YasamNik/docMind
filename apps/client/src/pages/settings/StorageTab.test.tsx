import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageTab } from "./StorageTab";

afterEach(() => cleanup());

const list = vi.fn(async () => [
  { key: "storage.activeDriver", value: "local", source: "default", secret: false, doc: "Active storage driver." },
]);
const update = vi.fn(async (_updates: Record<string, unknown>) => [] as unknown[]);

vi.mock("@/lib/settings-api", () => ({
  settingsApi: {
    list: () => list(),
    update: (updates: Record<string, unknown>) => update(updates),
  },
}));

describe("StorageTab", () => {
  it("edits and saves a storage setting", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StorageTab />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const input = screen.getByDisplayValue("local");
    fireEvent.change(input, { target: { value: "s3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith({ "storage.activeDriver": "s3" }));
  });
});
