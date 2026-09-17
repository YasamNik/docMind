import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

afterEach(() => cleanup());

vi.mock("@/lib/documents-api", () => ({
  documentsApi: {
    list: vi.fn(async (filters?: { view?: string }) => {
      if (filters?.view === "inbox") return [{ id: "doc_1" }];
      if (filters?.view === "needs_review") return [{ id: "doc_2" }, { id: "doc_3" }];
      return [];
    }),
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
  it("shows Inbox and Needs review counts, the category tree, and the tag list", async () => {
    renderShell();
    expect(await screen.findByText("Inbox")).toBeInTheDocument();
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(await screen.findByText("Finance")).toBeInTheDocument();
    expect(await screen.findByText("Rent")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Inbox").closest("a")).toHaveAttribute("href", "/documents?view=inbox");
    expect(screen.getByText("Needs review").closest("a")).toHaveAttribute("href", "/documents?view=needs_review");
    expect(screen.getByText("Rent").closest("a")).toHaveAttribute("href", "/documents?tagId=tag_1");
  });
});
