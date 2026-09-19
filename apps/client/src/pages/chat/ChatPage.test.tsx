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

const storageDriversMock = vi.fn(async () => [
  { id: "local", label: "Local filesystem", guide: { title: "", intro: "", steps: [], notes: [] }, configured: true, documentCount: 1, active: true },
  { id: "s3", label: "Amazon S3", guide: { title: "", intro: "", steps: [], notes: [] }, configured: true, documentCount: 1, active: false },
]);
vi.mock("@/lib/storage-api", () => ({
  storageApi: { list: () => storageDriversMock() },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // @ts-expect-error test-only cleanup of a browser API jsdom does not implement by default
  delete window.matchMedia;
});

// Simulates the phone breakpoint so ChatPage renders the full-width conversation with
// the sessions sheet, instead of the desktop two column layout. Without this,
// window.matchMedia does not exist in jsdom and the page reads as desktop, same as
// every test above that never calls this.
function mockMobileViewport() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === "(max-width: 767px)",
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

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
          citations: [{ documentId: "doc_1", documentName: "Lease.pdf", chunkText: "The rent is due on the first of the month.", chunkIndex: 0, storageDriver: "local" }],
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
    expect(screen.queryByText("Local filesystem")).not.toBeInTheDocument();
  });

  it("badges a citation for a document held on a storage that is not active", async () => {
    listSessionsMock.mockResolvedValueOnce([
      { id: "sess_1", title: "Lease question", documentScope: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    getSessionMock.mockResolvedValueOnce({
      session: { id: "sess_1", title: "Lease question", documentScope: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
      messages: [
        {
          id: "msg_1",
          sessionId: "sess_1",
          role: "assistant",
          content: "Your old lease is on file [1].",
          citations: [{ documentId: "doc_2", documentName: "Old lease.pdf", chunkText: "Archived lease text.", chunkIndex: 0, storageDriver: "s3" }],
          error: null,
          createdAt: "2026-01-01T00:01:00.000Z",
        },
      ],
    });

    renderPage();
    fireEvent.click(await screen.findByText("Lease question"));
    fireEvent.click(await screen.findByRole("button", { name: "1" }));

    expect(await screen.findByText("Archived lease text.")).toBeInTheDocument();
    expect(screen.getByText("Amazon S3")).toBeInTheDocument();
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
      'event: done\ndata: {"citations":[{"documentId":"doc_1","documentName":"Lease.pdf","chunkText":"Rent due on the first.","chunkIndex":0,"storageDriver":"local"}]}\n\n';
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

  it("keeps the composer's input element across keystrokes and types characters in order", async () => {
    listSessionsMock.mockResolvedValueOnce([
      { id: "sess_1", title: "Lease question", documentScope: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    getSessionMock.mockResolvedValueOnce({
      session: { id: "sess_1", title: "Lease question", documentScope: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
      messages: [],
    });

    renderPage();
    fireEvent.click(await screen.findByText("Lease question"));
    await screen.findByPlaceholderText("Ask about your documents...");

    // Simulates real typing: each keystroke inserts at the current caret rather than
    // replacing the whole value, and the caret is read from whatever input element is
    // live in the DOM right now. If the composer got remounted between keystrokes, the
    // fresh element would not carry the previous caret position forward, and this loop
    // would catch it as a changed element identity rather than a silently wrong caret.
    let previousElement: Element | null = null;
    let expected = "";
    for (const char of "What licence") {
      const live = screen.getByPlaceholderText("Ask about your documents...") as HTMLInputElement;
      if (previousElement) expect(live).toBe(previousElement);
      const caret = live.selectionStart ?? expected.length;
      expected = expected.slice(0, caret) + char + expected.slice(caret);
      fireEvent.change(live, { target: { value: expected } });
      const afterChange = screen.getByPlaceholderText("Ask about your documents...") as HTMLInputElement;
      afterChange.setSelectionRange(caret + 1, caret + 1);
      previousElement = afterChange;
    }

    expect((screen.getByPlaceholderText("Ask about your documents...") as HTMLInputElement).value).toBe("What licence");
  });
});

describe("ChatPage on a phone", () => {
  it("does not render the desktop sessions sidebar", async () => {
    mockMobileViewport();
    listSessionsMock.mockResolvedValueOnce([
      { id: "sess_1", title: "Lease question", documentScope: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    const { container } = renderPage();
    await screen.findByText("Chats");
    expect(container.querySelector('[data-slot="card"]')).not.toBeInTheDocument();
    // Exactly one "New chat" button exists at rest: the sheet holding the second one is closed.
    expect(screen.getByText("New chat")).toBeInTheDocument();
  });

  it("opens the sessions sheet from the header and switches chats from it", async () => {
    mockMobileViewport();
    listSessionsMock.mockResolvedValueOnce([
      { id: "sess_1", title: "Lease question", documentScope: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    getSessionMock.mockResolvedValueOnce({
      session: { id: "sess_1", title: "Lease question", documentScope: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
      messages: [],
    });
    renderPage();

    fireEvent.click(await screen.findByText("Chats"));
    const sheet = within(await screen.findByRole("dialog"));
    fireEvent.click(sheet.getByText("Lease question"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await screen.findByPlaceholderText("Ask about your documents...")).toBeInTheDocument();
  });

  it("still sends a message from the composer", async () => {
    mockMobileViewport();
    listSessionsMock.mockResolvedValueOnce([
      { id: "sess_1", title: "Lease question", documentScope: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    getSessionMock.mockResolvedValueOnce({
      session: { id: "sess_1", title: "Lease question", documentScope: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
      messages: [],
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 }),
    );

    renderPage();
    fireEvent.click(await screen.findByText("Chats"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByText("Lease question"));

    const input = await screen.findByPlaceholderText("Ask about your documents...");
    fireEvent.change(input, { target: { value: "When is rent due?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("When is rent due?")).toBeInTheDocument();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/chat/sessions/sess_1/messages");
  });

  it("deletes a session from the compact list after confirming", async () => {
    mockMobileViewport();
    listSessionsMock.mockResolvedValueOnce([
      { id: "sess_1", title: "Lease question", documentScope: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    renderPage();
    fireEvent.click(await screen.findByText("Chats"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByLabelText("Delete chat"));
    const confirmDialog = within(await screen.findByRole("dialog", { name: "Delete this chat?" }));
    fireEvent.click(confirmDialog.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteSessionMock).toHaveBeenCalledWith("sess_1"));
  });

  it("does not render the mobile layout at a normal viewport", async () => {
    listSessionsMock.mockResolvedValueOnce([
      { id: "sess_1", title: "Lease question", documentScope: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    renderPage();
    await screen.findByText("Lease question");
    expect(screen.queryByText("Chats")).not.toBeInTheDocument();
  });
});
