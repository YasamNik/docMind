import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import { jobsApi } from "@/lib/jobs-api";

afterEach(() => cleanup());

vi.mock("@/lib/documents-api", () => ({
  documentsApi: {
    counts: vi.fn(async () => ({ inbox: 1, needsReview: 2 })),
  },
}));

vi.mock("@/lib/tags-api", () => ({
  categoriesApi: { list: vi.fn(async () => [{ id: "cat_1", name: "Finance", parentId: null, documentCount: 1, path: "Finance" }]) },
  tagsApi: { list: vi.fn(async () => [{ id: "tag_1", name: "Rent", documentCount: 3 }]) },
}));

vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: vi.fn(async () => {}) } }));

vi.mock("@/lib/jobs-api", () => ({
  jobsApi: {
    counts: vi.fn(async () => ({ failed: 0 })),
  },
}));

// AppShell renders an <Outlet/>, which needs a real route match to resolve without
// throwing. A plain child route with no element renders nothing there, which is fine
// since this test only asserts on the sidebar.
function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/documents"]}>
      <QueryClientProvider client={new QueryClient()}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/documents" element={null} />
          </Route>
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

// jsdom does not implement matchMedia at all, so AppShell falls back to the desktop
// layout unless a test opts into the phone layout by mocking it, matching how a real
// browser reports a viewport narrower than the md breakpoint.
function mockMobileViewport(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe("AppShell", () => {
  it("shows Inbox and Needs review counts and Manage links, without category or tag lists", async () => {
    renderShell();
    expect(await screen.findByText("Inbox")).toBeInTheDocument();
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(screen.getByText("Inbox").closest("a")).toHaveAttribute("href", "/inbox");
    expect(screen.getByText("Needs review").closest("a")).toHaveAttribute("href", "/documents?view=needs_review");
    expect(screen.getByText("Manage categories").closest("a")).toHaveAttribute("href", "/categories");
    expect(screen.getByText("Manage tags").closest("a")).toHaveAttribute("href", "/tags");
    expect(screen.getByText("Sorting").closest("a")).toHaveAttribute("href", "/sorting");
    expect(screen.queryByText("Finance")).not.toBeInTheDocument();
    expect(screen.queryByText("Rent")).not.toBeInTheDocument();
  });
});

describe("AppShell on a phone", () => {
  beforeEach(() => mockMobileViewport(true));

  it("does not render the icon rail or the context panel", async () => {
    renderShell();
    await screen.findByRole("button", { name: "Open navigation menu" });
    expect(screen.queryByTitle("Sign out")).not.toBeInTheDocument();
    expect(screen.queryByText("Manage categories")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens a navigation drawer from the menu button, and closes it once a destination is chosen", async () => {
    renderShell();
    const menuButton = await screen.findByRole("button", { name: "Open navigation menu" });
    fireEvent.click(menuButton);

    const drawer = within(await screen.findByRole("dialog", { name: "Navigation" }));
    expect(drawer.getByText("Search")).toBeInTheDocument();
    expect(drawer.getByText("Manage categories")).toBeInTheDocument();

    fireEvent.click(drawer.getByText("Manage categories"));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows the failed job count in the top bar without opening the menu", async () => {
    vi.mocked(jobsApi.counts).mockResolvedValueOnce({ failed: 4 });
    renderShell();
    expect(await screen.findByLabelText("Failed jobs")).toHaveTextContent("4");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
