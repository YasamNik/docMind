import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
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

describe("JobsPage", () => {
  it("shows jobs with errors and retries failed ones", async () => {
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <JobsPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/No extractor for application\/zip/)).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: /retry/i });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(retry).toHaveBeenCalledWith("job_1"));
  });
});
