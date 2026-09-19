import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantTab } from "./AssistantTab";
import { formatReplacedAt } from "@/lib/format";
import type { InstructionsView } from "@/lib/assistant-api";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const instructions = vi.fn(async (): Promise<InstructionsView> => baseView());
const saveInstructions = vi.fn(async (body: string): Promise<InstructionsView> => ({ ...baseView(), body }));
const restoreInstructions = vi.fn(async (replacedAt: string): Promise<InstructionsView> => {
  const version = baseView().history.find((entry) => entry.replacedAt === replacedAt);
  return { ...baseView(), body: version?.body ?? "" };
});

vi.mock("@/lib/assistant-api", () => ({
  assistantApi: {
    instructions: () => instructions(),
    saveInstructions: (body: string) => saveInstructions(body),
    restoreInstructions: (replacedAt: string) => restoreInstructions(replacedAt),
  },
}));

const SHIPPED_DEFAULT = "The shipped default document, exactly as the server sends it.";

function baseView(): InstructionsView {
  return {
    body: "Keep replies short.",
    source: "db",
    maxChars: 8000,
    warnChars: 6000,
    shippedDefault: SHIPPED_DEFAULT,
    history: [
      { body: "An older version of my instructions.", replacedAt: "2026-09-18T14:02:00.000Z" },
      { body: "The very first version I wrote.", replacedAt: "2026-09-10T09:00:00.000Z" },
    ],
  };
}

// jsdom does not implement matchMedia at all, so mocking it simulates a phone the same
// way JobsPage.test.tsx and ChatPage.test.tsx do for their own mobile suites.
function mockMobileViewport() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === "(max-width: 767px)",
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // @ts-expect-error test-only cleanup of a browser API jsdom does not implement by default
  delete window.matchMedia;
});

function renderTab() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <AssistantTab />
    </QueryClientProvider>,
  );
}

describe("AssistantTab", () => {
  it("shows the saved document in the editor", async () => {
    renderTab();
    expect(await screen.findByDisplayValue("Keep replies short.")).toBeInTheDocument();
  });

  it("counts the characters against the limit", async () => {
    renderTab();
    const textarea = await screen.findByDisplayValue("Keep replies short.");
    expect(screen.getByText(/^19 \/ 8,000 characters$/)).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: "Keep replies short and clear." } });
    expect(screen.getByText(/^29 \/ 8,000 characters$/)).toBeInTheDocument();
  });

  it("warns once the document passes the warning threshold", async () => {
    instructions.mockResolvedValueOnce({ ...baseView(), warnChars: 25 });
    renderTab();
    const textarea = await screen.findByDisplayValue("Keep replies short.");
    const counter = screen.getByText(/\/ 8,000 characters$/);
    expect(counter.className).not.toContain("text-yellow");
    fireEvent.change(textarea, { target: { value: "This is well past ten characters." } });
    expect(counter.className).toContain("text-yellow");
  });

  it("refuses to save a document over the limit, and says how much to cut", async () => {
    instructions.mockResolvedValueOnce({ ...baseView(), maxChars: 20 });
    renderTab();
    const textarea = await screen.findByDisplayValue("Keep replies short.");
    fireEvent.change(textarea, { target: { value: "This document is now over the twenty character cap." } });

    expect(await screen.findByText(/too long to save/i)).toBeInTheDocument();
    expect(screen.getByText(/shorten it by 31 characters/i)).toBeInTheDocument();
    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).toBeDisabled();

    fireEvent.click(saveButton);
    expect(saveInstructions).not.toHaveBeenCalled();
  });

  it("keeps Save disabled until the text actually changes", async () => {
    renderTab();
    const textarea = await screen.findByDisplayValue("Keep replies short.");
    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "Keep replies short and clear." } });
    expect(saveButton).not.toBeDisabled();

    fireEvent.change(textarea, { target: { value: "Keep replies short." } });
    expect(saveButton).toBeDisabled();
  });

  it("saves the edited document and tells the user", async () => {
    const { toast } = await import("sonner");
    renderTab();
    const textarea = await screen.findByDisplayValue("Keep replies short.");
    fireEvent.change(textarea, { target: { value: "Keep replies short and clear." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveInstructions).toHaveBeenCalledWith("Keep replies short and clear."));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("shows the server's own message when a save is refused", async () => {
    const { toast } = await import("sonner");
    saveInstructions.mockRejectedValueOnce(new Error("Your instructions are 8001 characters, over the 8000 character limit. Shorten them and save again."));
    renderTab();
    const textarea = await screen.findByDisplayValue("Keep replies short.");
    fireEvent.change(textarea, { target: { value: "Keep replies short and clear." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Your instructions are 8001 characters, over the 8000 character limit. Shorten them and save again.",
      ),
    );
  });

  it("fills the editor with the shipped default without saving anything", async () => {
    renderTab();
    const textarea = await screen.findByDisplayValue("Keep replies short.");

    fireEvent.click(screen.getByRole("button", { name: /reset to the shipped default/i }));

    expect(textarea).toHaveDisplayValue(SHIPPED_DEFAULT);
    expect(saveInstructions).not.toHaveBeenCalled();
  });

  it("keeps the previous text recoverable in history once a reset is saved", async () => {
    saveInstructions.mockResolvedValueOnce({
      ...baseView(),
      body: SHIPPED_DEFAULT,
      history: [{ body: "Keep replies short.", replacedAt: "2026-09-19T10:00:00.000Z" }, ...baseView().history],
    });
    renderTab();
    await screen.findByDisplayValue("Keep replies short.");

    fireEvent.click(screen.getByRole("button", { name: /reset to the shipped default/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveInstructions).toHaveBeenCalledWith(SHIPPED_DEFAULT));
    expect(await screen.findByText(`In use until ${formatReplacedAt("2026-09-19T10:00:00.000Z")}`)).toBeInTheDocument();
  });

  it("disables the reset control once the editor already holds the shipped default", async () => {
    instructions.mockResolvedValueOnce({ ...baseView(), body: SHIPPED_DEFAULT });
    renderTab();
    await screen.findByDisplayValue(SHIPPED_DEFAULT);

    expect(screen.getByRole("button", { name: /reset to the shipped default/i })).toBeDisabled();
  });

  it("re-disables reset once an edit brings the text back to the shipped default", async () => {
    renderTab();
    const textarea = await screen.findByDisplayValue("Keep replies short.");
    const resetButton = screen.getByRole("button", { name: /reset to the shipped default/i });
    expect(resetButton).not.toBeDisabled();

    fireEvent.change(textarea, { target: { value: SHIPPED_DEFAULT } });
    expect(resetButton).toBeDisabled();
  });

  it("lists previous versions newest first, with when each stopped being used", async () => {
    renderTab();
    await screen.findByDisplayValue("Keep replies short.");

    const rows = screen.getAllByText(/^In use until/);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(`In use until ${formatReplacedAt("2026-09-18T14:02:00.000Z")}`);
    expect(rows[1]).toHaveTextContent(`In use until ${formatReplacedAt("2026-09-10T09:00:00.000Z")}`);
  });

  it("previews a version without replacing what is in the editor", async () => {
    renderTab();
    await screen.findByDisplayValue("Keep replies short.");

    fireEvent.click(screen.getAllByText(/^In use until/)[0]!);

    expect(await screen.findByText("An older version of my instructions.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Keep replies short.")).toBeInTheDocument();
  });

  it("asks before restoring, and says the current text is kept", async () => {
    renderTab();
    await screen.findByDisplayValue("Keep replies short.");

    fireEvent.click(screen.getAllByText(/^In use until/)[0]!);
    await screen.findByText("An older version of my instructions.");
    fireEvent.click(screen.getByRole("button", { name: /restore this version/i }));

    expect(screen.getByText(/the text you have now is kept in the history/i)).toBeInTheDocument();
    expect(restoreInstructions).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(restoreInstructions).toHaveBeenCalledWith("2026-09-18T14:02:00.000Z"));
  });

  it("says the document cannot give the assistant new abilities", async () => {
    renderTab();
    await screen.findByDisplayValue("Keep replies short.");
    expect(screen.getByText(/cannot give the assistant new abilities/i)).toBeInTheDocument();
  });
});

describe("AssistantTab on a phone", () => {
  it("keeps the editor, the counter and the save action usable at a phone width", async () => {
    mockMobileViewport();
    renderTab();

    const textarea = await screen.findByDisplayValue("Keep replies short.");
    expect(textarea.className).toContain("w-full");
    fireEvent.change(textarea, { target: { value: "Keep replies short and clear." } });

    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);
    await waitFor(() => expect(saveInstructions).toHaveBeenCalled());
  });

  it("keeps the history reachable and its rows readable at a phone width", async () => {
    mockMobileViewport();
    renderTab();
    await screen.findByDisplayValue("Keep replies short.");

    const rows = screen.getAllByText(/^In use until/);
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[0]!);
    expect(await screen.findByText("An older version of my instructions.")).toBeInTheDocument();
  });
});
