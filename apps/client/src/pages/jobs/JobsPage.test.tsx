import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobsPage } from "./JobsPage";

const retry = vi.fn(async (id: string) => ({ id, status: "pending" }));
vi.mock("@/lib/jobs-api", () => ({
  jobsApi: {
    list: vi.fn(async () => [
      { id: "job_1", type: "extraction", status: "failed", attempts: 3, error: "No extractor for application/zip", payload: { documentId: "doc_1" }, createdAt: "2026-09-16T10:00:00.000Z" },
      { id: "job_2", type: "extraction", status: "done", attempts: 1, error: null, payload: { documentId: "doc_2" }, createdAt: "2026-09-16T10:01:00.000Z" },
    ]),
    retry: (id: string) => retry(id),
  },
}));

afterEach(() => {
  cleanup();
  // @ts-expect-error test-only cleanup of a browser API jsdom does not implement by default
  delete window.matchMedia;
});

// Simulates the phone breakpoint so JobsPage renders its card list instead of the table.
function mockMobileViewport() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === "(max-width: 767px)",
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function renderPage() {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <JobsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("JobsPage", () => {
  it("shows jobs with errors and retries failed ones", async () => {
    renderPage();
    expect(await screen.findByText(/No extractor for application\/zip/)).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: /retry/i });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(retry).toHaveBeenCalledWith("job_1"));
  });
});

describe("JobsPage on a phone", () => {
  it("renders a card per job instead of the table", async () => {
    mockMobileViewport();
    const { container } = renderPage();
    await screen.findByText(/No extractor for application\/zip/);
    expect(container.querySelector("table")).not.toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(2);
  });

  it("keeps the retry button reachable and links to the document", async () => {
    mockMobileViewport();
    renderPage();
    await screen.findByText(/No extractor for application\/zip/);
    expect(screen.getByRole("link", { name: "doc_1" })).toHaveAttribute("href", "/documents/doc_1");
    const buttons = screen.getAllByRole("button", { name: /retry/i });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(retry).toHaveBeenCalledWith("job_1"));
  });
});
