import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailTab } from "./EmailTab";
import type { EmailStatus, EmailTestResult } from "@/lib/email-api";
import type { ResolvedSetting } from "@/lib/settings-api";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => cleanup());

// Annotated rather than inferred: without this the first fixture's literal shape
// narrows the mock's type, and a later fixture with different fields stops compiling.
const testConnection = vi.fn(async (): Promise<EmailTestResult> => ({ ok: true, message: "Connected. 3 messages waiting." }));
const getStatus = vi.fn(async (): Promise<EmailStatus> => ({
  mode: "unconfigured",
  googleAppAvailable: false,
  redirectUri: "https://example.com/api/storage/oauth/callback",
  needsReconnect: false,
}));
const updateSettings = vi.fn(async (_updates: Record<string, unknown>) => [] as unknown[]);
const listSettings = vi.fn(async (): Promise<ResolvedSetting[]> => []);

vi.mock("@/lib/email-api", () => ({
  emailApi: {
    test: () => testConnection(),
    status: () => getStatus(),
  },
}));

vi.mock("@/lib/settings-api", () => ({
  settingsApi: {
    update: (updates: Record<string, unknown>) => updateSettings(updates),
    list: () => listSettings(),
  },
}));

const baseSettings: ResolvedSetting[] = [
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
  return baseSettings.map((setting) => {
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

describe("EmailTab, no mailbox connected", () => {
  beforeEach(() => {
    testConnection.mockReset().mockResolvedValue({ ok: true, message: "Connected. 3 messages waiting." });
    updateSettings.mockClear();
    listSettings.mockReset().mockResolvedValue(baseSettings);
    getStatus.mockReset();
  });

  it("shows a Connect Gmail button that says it reuses the Google app already set up for Drive", async () => {
    getStatus.mockResolvedValue({
      mode: "unconfigured",
      googleAppAvailable: true,
      redirectUri: "https://example.com/api/storage/oauth/callback",
      needsReconnect: false,
    });
    renderEmailTab();

    const link = await screen.findByRole("link", { name: "Connect Gmail" });
    expect(link).toHaveAttribute("href", "/api/email/gmail/connect");
    expect(screen.getByText(/already set up for google drive/i)).toBeInTheDocument();
  });

  it("shows the redirect uri to register when a Google app is available to connect with", async () => {
    getStatus.mockResolvedValue({
      mode: "unconfigured",
      googleAppAvailable: true,
      redirectUri: "https://example.com/api/storage/oauth/callback",
      needsReconnect: false,
    });
    renderEmailTab();

    await screen.findByRole("link", { name: "Connect Gmail" });
    expect(screen.getByText("https://example.com/api/storage/oauth/callback")).toBeInTheDocument();
  });

  it("points at the Storage tab instead of a Connect button when no Google app is configured", async () => {
    getStatus.mockResolvedValue({
      mode: "unconfigured",
      googleAppAvailable: false,
      redirectUri: "https://example.com/api/storage/oauth/callback",
      needsReconnect: false,
    });
    renderEmailTab();

    expect(await screen.findByText(/storage tab/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Connect Gmail" })).not.toBeInTheDocument();
  });

  it("keeps the host, port, user and password fields for another provider behind a closed disclosure", async () => {
    getStatus.mockResolvedValue({
      mode: "unconfigured",
      googleAppAvailable: false,
      redirectUri: "https://example.com/api/storage/oauth/callback",
      needsReconnect: false,
    });
    renderEmailTab();
    await screen.findByText(/storage tab/i);

    const hostLabel = screen.getByText(/imap server hostname/i);
    expect(hostLabel).not.toBeVisible();

    fireEvent.click(screen.getByText(/not.*gmail/i));
    expect(hostLabel).toBeVisible();
  });

  it("saves a plain text connection setting through the settings api once the disclosure is open", async () => {
    getStatus.mockResolvedValue({
      mode: "unconfigured",
      googleAppAvailable: false,
      redirectUri: "https://example.com/api/storage/oauth/callback",
      needsReconnect: false,
    });
    renderEmailTab();
    await screen.findByText(/storage tab/i);
    fireEvent.click(screen.getByText(/not.*gmail/i));

    const hostField = screen.getByText(/imap server hostname/i).closest("div") as HTMLElement;
    fireEvent.click(within(hostField).getByRole("button", { name: "Edit" }));
    const input = within(hostField).getByRole("textbox");
    fireEvent.change(input, { target: { value: "imap.gmail.com" } });
    fireEvent.click(within(hostField).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ "email.imap.host": "imap.gmail.com" }),
    );
  });

  it("shows what the Test button reports", async () => {
    getStatus.mockResolvedValue({
      mode: "unconfigured",
      googleAppAvailable: false,
      redirectUri: "https://example.com/api/storage/oauth/callback",
      needsReconnect: false,
    });
    renderEmailTab();
    await screen.findByText(/storage tab/i);

    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    expect(await screen.findByText("Connected. 3 messages waiting.")).toBeInTheDocument();
  });

  it("shows a Gmail setup guide naming the exact console clicks and the two warnings, when a Connect button is offered", async () => {
    getStatus.mockResolvedValue({
      mode: "unconfigured",
      googleAppAvailable: true,
      redirectUri: "https://example.com/api/storage/oauth/callback",
      needsReconnect: false,
    });
    renderEmailTab();

    expect(await screen.findByText(/turn on the gmail api/i)).toBeInTheDocument();
    expect(screen.getByText(/mail\.google\.com/)).toBeInTheDocument();
    expect(screen.getByText(/read, send and delete/i)).toBeInTheDocument();
    expect(screen.getByText(/never sends or deletes/i)).toBeInTheDocument();
    expect(screen.getByText(/about once a week/i)).toBeInTheDocument();
  });
});

describe("EmailTab, Gmail connected", () => {
  beforeEach(() => {
    testConnection.mockReset().mockResolvedValue({ ok: true, message: "Connected. 3 messages waiting." });
    updateSettings.mockClear();
    listSettings.mockReset().mockResolvedValue(configuredSettings());
    getStatus.mockReset().mockResolvedValue({
      mode: "gmail",
      connectedAs: "me@gmail.com",
      googleAppAvailable: true,
      redirectUri: "https://example.com/api/storage/oauth/callback",
      needsReconnect: false,
    });
  });

  it("shows the connected address, a Disconnect action, and the mailbox settings", async () => {
    renderEmailTab();

    expect(await screen.findByText(/me@gmail\.com/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(screen.getByText(/the folder docmind watches/i)).toBeInTheDocument();
    expect(screen.getByText(/how often the watched folder is checked/i)).toBeInTheDocument();
  });

  it("does not show the host, port, mailbox address or app password fields on screen", async () => {
    renderEmailTab();
    await screen.findByText(/me@gmail\.com/);

    expect(screen.getByText(/imap server hostname/i)).not.toBeVisible();
    expect(screen.getByText(/imap server port/i)).not.toBeVisible();
    expect(screen.getByText(/mailbox address to sign in as/i)).not.toBeVisible();
  });

  it("never tells a connected mailbox to go and create an app password", async () => {
    // The guide used to fall back to the IMAP one for any mode but unconfigured, so a
    // mailbox signed in over OAuth was told to make an app password and type a host.
    renderEmailTab();
    expect(await screen.findByText(/Gmail is connected/i)).toBeInTheDocument();
    expect(screen.queryByText(/Create an app password/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Enter the host, port, mailbox address/i)).not.toBeInTheDocument();
  });

  it("disconnects Gmail through the settings api after confirming", async () => {
    renderEmailTab();
    await screen.findByText(/me@gmail\.com/);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Gmail" }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        "email.gmail.refreshToken": null,
        "email.gmail.accountEmail": null,
      }),
    );
  });
});

describe("EmailTab, Gmail needs reconnecting", () => {
  beforeEach(() => {
    testConnection.mockReset().mockResolvedValue({ ok: true, message: "Connected. 3 messages waiting." });
    updateSettings.mockClear();
    listSettings.mockReset().mockResolvedValue(configuredSettings());
    getStatus.mockReset().mockResolvedValue({
      mode: "gmail",
      connectedAs: "me@gmail.com",
      googleAppAvailable: true,
      redirectUri: "https://example.com/api/storage/oauth/callback",
      needsReconnect: true,
      lastError: "Gmail access has expired or been revoked. Reconnect the account.",
    });
  });

  it("shows a banner saying mail collection has stopped, with one button to fix it", async () => {
    renderEmailTab();

    expect(await screen.findByText(/mail collection has stopped/i)).toBeInTheDocument();
    const fix = screen.getByRole("link", { name: /reconnect/i });
    expect(fix).toHaveAttribute("href", "/api/email/gmail/connect");
  });
});

describe("EmailTab on a phone", () => {
  // jsdom does not implement matchMedia at all; the tab does not read it, so this only
  // needs to confirm nothing about the layout depends on a wider viewport being present.
  function mockMobileViewport() {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 767px)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  }

  afterEach(() => {
    // @ts-expect-error test-only cleanup of a browser API jsdom does not implement by default
    delete window.matchMedia;
  });

  beforeEach(() => {
    testConnection.mockReset().mockResolvedValue({ ok: true, message: "Connected. 3 messages waiting." });
    updateSettings.mockClear();
    listSettings.mockReset().mockResolvedValue(baseSettings);
    getStatus.mockReset().mockResolvedValue({
      mode: "unconfigured",
      googleAppAvailable: true,
      redirectUri: "https://example.com/api/storage/oauth/callback",
      needsReconnect: false,
    });
  });

  it("keeps the Connect Gmail button reachable at a phone width", async () => {
    mockMobileViewport();
    renderEmailTab();

    const link = await screen.findByRole("link", { name: "Connect Gmail" });
    expect(link.className).not.toContain("hidden");
  });

  it("keeps the reconnect banner and its button reachable at a phone width", async () => {
    mockMobileViewport();
    getStatus.mockResolvedValue({
      mode: "gmail",
      connectedAs: "me@gmail.com",
      googleAppAvailable: true,
      redirectUri: "https://example.com/api/storage/oauth/callback",
      needsReconnect: true,
    });
    renderEmailTab();

    expect(await screen.findByText(/mail collection has stopped/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /reconnect/i })).toBeInTheDocument();
  });
});
