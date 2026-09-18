import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

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
