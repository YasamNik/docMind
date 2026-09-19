import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailTab } from "./EmailTab";
import type { EmailTestResult } from "@/lib/email-api";
import type { ResolvedSetting } from "@/lib/settings-api";

afterEach(() => cleanup());

// Annotated rather than inferred: without this the first fixture's literal shape
// narrows the mock's type, and a later fixture with different fields stops compiling.
const testConnection = vi.fn(async (): Promise<EmailTestResult> => ({ ok: true, message: "Connected. 3 messages waiting." }));
const updateSettings = vi.fn(async (_updates: Record<string, unknown>) => [] as unknown[]);
const listSettings = vi.fn(async (): Promise<ResolvedSetting[]> => []);

vi.mock("@/lib/email-api", () => ({
  emailApi: {
    test: () => testConnection(),
  },
}));

vi.mock("@/lib/settings-api", () => ({
  settingsApi: {
    update: (updates: Record<string, unknown>) => updateSettings(updates),
    list: () => listSettings(),
  },
}));

const unconfiguredSettings: ResolvedSetting[] = [
  { key: "email.imap.host", value: undefined, source: "unset", secret: false, doc: "IMAP server hostname, for example imap.gmail.com." },
  { key: "email.imap.port", value: 993, source: "default", secret: false, doc: "IMAP server port." },
  { key: "email.imap.user", value: undefined, source: "unset", secret: false, doc: "The mailbox address to sign in as." },
  { key: "email.imap.password", value: { isSet: false }, source: "unset", secret: true, doc: "An app password for the mailbox. Never the account password." },
  { key: "email.imap.folder", value: "DocMind", source: "default", secret: false, doc: "The folder DocMind watches for mail to take in." },
  { key: "email.imap.doneFolder", value: "DocMind/Done", source: "default", secret: false, doc: "Where a handled message is moved so it is never taken in twice." },
  { key: "email.imap.failedFolder", value: "DocMind/Failed", source: "default", secret: false, doc: "Where a message is moved after it fails to be taken in a bounded number of times." },
  { key: "email.imap.pollSeconds", value: 60, source: "default", secret: false, doc: "How often the watched folder is checked." },
  { key: "email.imap.maxMessageSizeMb", value: 25, source: "default", secret: false, doc: "Messages larger than this are moved to Failed without being downloaded." },
];

function configuredSettings(overrides: Partial<Record<string, unknown>> = {}): ResolvedSetting[] {
  return unconfiguredSettings.map((setting) => {
    if (setting.key === "email.imap.host") return { ...setting, value: "imap.gmail.com", source: "db" as const };
    if (setting.key === "email.imap.user") return { ...setting, value: "me@example.com", source: "db" as const };
    if (setting.key === "email.imap.password") {
      return { ...setting, value: overrides.password ?? { isSet: true, lastFour: "9f2a" }, source: "db" as const };
    }
    return setting;
  });
}

function renderEmailTab() {
  const queryClient = new QueryClient();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <EmailTab />
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

describe("EmailTab", () => {
  beforeEach(() => {
    testConnection.mockReset().mockResolvedValue({ ok: true, message: "Connected. 3 messages waiting." });
    updateSettings.mockClear();
    listSettings.mockReset().mockResolvedValue(unconfiguredSettings);
  });

  it("shows the host, folder and poll settings with their explanations", async () => {
    renderEmailTab();

    expect(await screen.findByText(/imap server hostname/i)).toBeInTheDocument();
    expect(screen.getByText(/the folder docmind watches/i)).toBeInTheDocument();
    expect(screen.getByText(/how often the watched folder is checked/i)).toBeInTheDocument();
  });

  it("saves a plain text setting through the settings api", async () => {
    renderEmailTab();
    await screen.findByText(/imap server hostname/i);

    const hostField = screen.getByText(/imap server hostname/i).closest("div") as HTMLElement;
    fireEvent.click(within(hostField).getByRole("button", { name: "Edit" }));
    const input = within(hostField).getByRole("textbox");
    fireEvent.change(input, { target: { value: "imap.gmail.com" } });
    fireEvent.click(within(hostField).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ "email.imap.host": "imap.gmail.com" }),
    );
  });

  it("shows the max message size setting and saves it as a number", async () => {
    renderEmailTab();
    await screen.findByText(/messages larger than this are moved to failed/i);

    const sizeField = screen.getByText(/messages larger than this are moved to failed/i).closest("div") as HTMLElement;
    fireEvent.click(within(sizeField).getByRole("button", { name: "Edit" }));
    const input = within(sizeField).getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.click(within(sizeField).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ "email.imap.maxMessageSizeMb": 10 }),
    );
  });

  it("saves the port as a number, not a string", async () => {
    renderEmailTab();
    await screen.findByText(/imap server port/i);

    const portField = screen.getByText(/imap server port/i).closest("div") as HTMLElement;
    fireEvent.click(within(portField).getByRole("button", { name: "Edit" }));
    const input = within(portField).getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "995" } });
    fireEvent.click(within(portField).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ "email.imap.port": 995 }),
    );
  });

  it("never prefills the password, and shows a form to set it before one exists", async () => {
    renderEmailTab();

    expect(await screen.findByPlaceholderText(/app password/i)).toHaveValue("");
  });

  it("shows a saved password as masked with a Replace action, not the value", async () => {
    listSettings.mockResolvedValue(configuredSettings());
    renderEmailTab();

    expect(await screen.findByText(/set, ends in ····9f2a/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/app password/i)).not.toBeInTheDocument();
  });

  it("replaces the password through the settings api without ever prefilling the old one", async () => {
    listSettings.mockResolvedValue(configuredSettings());
    renderEmailTab();
    await screen.findByText(/set, ends in ····9f2a/i);

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    const input = await screen.findByPlaceholderText(/app password/i);
    expect(input).toHaveValue("");

    fireEvent.change(input, { target: { value: "newapppassword" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ "email.imap.password": "newapppassword" }),
    );
  });

  it("shows what the Test button reports, on success", async () => {
    renderEmailTab();
    await screen.findByText(/imap server hostname/i);

    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    expect(await screen.findByText("Connected. 3 messages waiting.")).toBeInTheDocument();
  });

  it("shows what the Test button reports, on failure", async () => {
    testConnection.mockResolvedValue({ ok: false, message: "Authentication failed." });
    renderEmailTab();
    await screen.findByText(/imap server hostname/i);

    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    expect(await screen.findByText("Authentication failed.")).toBeInTheDocument();
  });

  it("shows a setup guide covering app passwords, the folder needing to exist first, and what DocMind never touches", async () => {
    renderEmailTab();

    expect(await screen.findByText(/connect a mailbox over imap/i)).toBeInTheDocument();
    expect(screen.getAllByText(/app password/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/create the folder .* before/i)).toBeInTheDocument();
    expect(screen.getByText(/never touches your inbox/i)).toBeInTheDocument();
    expect(screen.getByText(/never deletes/i)).toBeInTheDocument();
  });
});
