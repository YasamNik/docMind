import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatSession } from "@/lib/chat-api";
import { ChatPage } from "./ChatPage";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const listSessionsMock = vi.fn(async (): Promise<ChatSession[]> => []);
const createSessionMock = vi.fn(
  async (_scope?: string[]): Promise<ChatSession> => ({
    id: "sess_new",
    title: null,
    documentScope: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }),
);
const getSessionMock = vi.fn(
  async (id: string): Promise<{ session: ChatSession; messages: ChatMessage[] }> => ({
    session: { id, title: null, documentScope: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    messages: [],
  }),
);
const deleteSessionMock = vi.fn(async (_id: string): Promise<void> => undefined);

vi.mock("@/lib/chat-api", () => ({
  chatApi: {
    listSessions: () => listSessionsMock(),
    createSession: (scope?: string[]) => createSessionMock(scope),
    getSession: (id: string) => getSessionMock(id),
    deleteSession: (id: string) => deleteSessionMock(id),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ChatPage", () => {
  it("shows the empty state when no session is selected", async () => {
    renderPage();
    expect(await screen.findByText("Start a new chat to ask questions about your documents.")).toBeInTheDocument();
  });

  it("creates a new session and switches to it", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("New chat"));
    await waitFor(() => expect(createSessionMock).toHaveBeenCalled());
    await waitFor(() => expect(getSessionMock).toHaveBeenCalledWith("sess_new"));
    expect(await screen.findByPlaceholderText("Ask about your documents...")).toBeInTheDocument();
  });

  it("displays messages and citations for the selected session", async () => {
    listSessionsMock.mockResolvedValueOnce([
      { id: "sess_1", title: "Lease question", documentScope: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    getSessionMock.mockResolvedValueOnce({
      session: { id: "sess_1", title: "Lease question", documentScope: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
      messages: [
        {
          id: "msg_1",
          sessionId: "sess_1",
          role: "user",
          content: "When is rent due?",
          citations: null,
          error: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "msg_2",
          sessionId: "sess_1",
          role: "assistant",
          content: "Rent is due on the first [1].",
          citations: [{ documentId: "doc_1", documentName: "Lease.pdf", chunkText: "The rent is due on the first of the month.", chunkIndex: 0 }],
          error: null,
          createdAt: "2026-01-01T00:01:00.000Z",
        },
      ],
    });

    renderPage();
    fireEvent.click(await screen.findByText("Lease question"));

    expect(await screen.findByText("When is rent due?")).toBeInTheDocument();
    expect(await screen.findByText("Rent is due on the first [1].")).toBeInTheDocument();

    const badge = screen.getByRole("button", { name: "1" });
    fireEvent.click(badge);
    expect(await screen.findByText("The rent is due on the first of the month.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Lease.pdf" })).toHaveAttribute("href", "/documents/doc_1");
  });

  it("deletes a session after confirming", async () => {
    listSessionsMock.mockResolvedValueOnce([
      { id: "sess_1", title: "Lease question", documentScope: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    renderPage();
    fireEvent.click(await screen.findByLabelText("Delete chat"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteSessionMock).toHaveBeenCalledWith("sess_1"));
  });

  it("streams an assistant reply token by token and shows the final citations", async () => {
    listSessionsMock.mockResolvedValueOnce([
      { id: "sess_1", title: "Lease question", documentScope: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    getSessionMock.mockResolvedValueOnce({
      session: { id: "sess_1", title: "Lease question", documentScope: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
      messages: [],
    });

    const sseBody =
      "event: token\ndata: Rent\n\n" +
      "event: token\ndata:  is due on the first [1].\n\n" +
      'event: done\ndata: {"citations":[{"documentId":"doc_1","documentName":"Lease.pdf","chunkText":"Rent due on the first.","chunkIndex":0}]}\n\n';
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseBody.slice(0, 20)));
        controller.enqueue(encoder.encode(sseBody.slice(20)));
        controller.close();
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { status: 200 }));

    renderPage();
    fireEvent.click(await screen.findByText("Lease question"));
    const input = await screen.findByPlaceholderText("Ask about your documents...");
    fireEvent.change(input, { target: { value: "When is rent due?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("When is rent due?")).toBeInTheDocument();
    expect(await screen.findByText("Rent is due on the first [1].")).toBeInTheDocument();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/chat/sessions/sess_1/messages");
    expect(screen.getByRole("button", { name: "1" })).toBeInTheDocument();
  });
});
