import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramTab } from "./TelegramTab";
import type { TelegramStatus } from "@/lib/telegram-api";
import type { ResolvedSetting } from "@/lib/settings-api";

afterEach(() => cleanup());

// Annotated rather than inferred: without this the first fixture's literal shape
// narrows the mock's type, and a later fixture with different fields stops compiling.
const getStatus = vi.fn(async (): Promise<TelegramStatus> => ({ tokenSet: false, paired: false }));
const requestPairingCode = vi.fn(async () => ({ pairingCode: "NEWCODE" }));
const unpair = vi.fn(async () => ({ ok: true as const }));
const updateSettings = vi.fn(async (_updates: Record<string, unknown>) => [] as unknown[]);
const listSettings = vi.fn(async (): Promise<ResolvedSetting[]> => []);

vi.mock("@/lib/telegram-api", () => ({
  telegramApi: {
    status: () => getStatus(),
    requestPairingCode: () => requestPairingCode(),
    unpair: () => unpair(),
  },
}));

vi.mock("@/lib/settings-api", () => ({
  settingsApi: {
    update: (updates: Record<string, unknown>) => updateSettings(updates),
    list: () => listSettings(),
  },
}));

// The settings registry marks telegram.botToken as secret, so the resolved value the
// list endpoint returns is a masked shape, never the plaintext, the same as any other
// secret setting in the registry.
function maskedTokenSetting(lastFour?: string): ResolvedSetting {
  return {
    key: "telegram.botToken",
    value: { isSet: true, lastFour },
    source: "db",
    secret: true,
    doc: "Token for the Telegram bot, from BotFather.",
  };
}

function renderTelegramTab() {
  const queryClient = new QueryClient();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <TelegramTab />
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

describe("TelegramTab", () => {
  beforeEach(() => {
    getStatus.mockReset().mockResolvedValue({ tokenSet: false, paired: false });
    requestPairingCode.mockReset().mockResolvedValue({ pairingCode: "NEWCODE" });
    unpair.mockReset().mockResolvedValue({ ok: true });
    updateSettings.mockClear();
    listSettings.mockReset().mockResolvedValue([]);
  });

  it("walks through BotFather before a token is saved", async () => {
    renderTelegramTab();

    expect(await screen.findByText(/message @BotFather/i)).toBeInTheDocument();
    expect(screen.getByText(/send \/newbot/i)).toBeInTheDocument();
    expect(screen.getByText(/username ending in bot/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/paste the token/i)).toBeInTheDocument();
  });

  it("saves the token through the settings api, not a telegram route", async () => {
    renderTelegramTab();
    const input = await screen.findByPlaceholderText(/paste the token/i);

    fireEvent.change(input, { target: { value: "123:SECRETVALUE" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ "telegram.botToken": "123:SECRETVALUE" }),
    );
  });

  it("never renders the saved token back into a field", async () => {
    getStatus.mockResolvedValue({ tokenSet: true, paired: false, pairingCode: "ABCDEF" });
    renderTelegramTab();

    await screen.findByText("ABCDEF");
    expect(screen.queryByPlaceholderText(/paste the token/i)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(/123:/)).not.toBeInTheDocument();
  });

  it("shows the pairing code and what to do with it once a token is saved", async () => {
    getStatus.mockResolvedValue({ tokenSet: true, paired: false, pairingCode: "ABCDEF" });
    renderTelegramTab();

    expect(await screen.findByText("ABCDEF")).toBeInTheDocument();
    expect(screen.getByText(/send that code to your bot/i)).toBeInTheDocument();
    expect(screen.getByText(/ignores everyone else/i)).toBeInTheDocument();
  });

  it("requests a fresh pairing code and shows it", async () => {
    getStatus.mockResolvedValue({ tokenSet: true, paired: false, pairingCode: "ABCDEF" });
    renderTelegramTab();
    await screen.findByText("ABCDEF");

    fireEvent.click(screen.getByRole("button", { name: /get a new code/i }));

    await waitFor(() => expect(requestPairingCode).toHaveBeenCalled());
  });

  it("shows who it is paired with, and offers Unpair", async () => {
    getStatus.mockResolvedValue({ tokenSet: true, paired: true, pairedName: "Yasam" });
    renderTelegramTab();

    expect(await screen.findByText(/paired with Yasam/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unpair" })).toBeInTheDocument();
  });

  it("confirms before unpairing and says the bot stops accepting anything", async () => {
    getStatus.mockResolvedValue({ tokenSet: true, paired: true, pairedName: "Yasam" });
    renderTelegramTab();
    await screen.findByText(/paired with Yasam/i);

    fireEvent.click(screen.getByRole("button", { name: "Unpair" }));

    expect(await screen.findByText(/stops accepting anything until it is paired again/i)).toBeInTheDocument();
    expect(unpair).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Unpair Telegram" }));

    await waitFor(() => expect(unpair).toHaveBeenCalled());
  });

  it("shows a saved token as masked, with a Replace action, once a token is set", async () => {
    getStatus.mockResolvedValue({ tokenSet: true, paired: false, pairingCode: "ABCDEF" });
    listSettings.mockResolvedValue([maskedTokenSetting("7890")]);
    renderTelegramTab();

    expect(await screen.findByText(/set, ends in ····7890/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/paste the token/i)).not.toBeInTheDocument();
  });

  it("falls back to a plain masked marker when the settings list has no last four yet", async () => {
    getStatus.mockResolvedValue({ tokenSet: true, paired: false, pairingCode: "ABCDEF" });
    renderTelegramTab();

    expect(await screen.findByText(/set, ends in \*\*\*\*/i)).toBeInTheDocument();
  });

  it("replaces the token through the settings api without ever prefilling the old one", async () => {
    getStatus.mockResolvedValue({ tokenSet: true, paired: false, pairingCode: "ABCDEF" });
    listSettings.mockResolvedValue([maskedTokenSetting("7890")]);
    renderTelegramTab();
    await screen.findByText(/set, ends in ····7890/i);

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    const input = await screen.findByPlaceholderText(/paste the token/i);
    expect(input).toHaveValue("");

    fireEvent.change(input, { target: { value: "222:NEWVALUE" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ "telegram.botToken": "222:NEWVALUE" }),
    );
  });

  it("cancels out of replacing back to the masked view without saving", async () => {
    getStatus.mockResolvedValue({ tokenSet: true, paired: false, pairingCode: "ABCDEF" });
    listSettings.mockResolvedValue([maskedTokenSetting("7890")]);
    renderTelegramTab();
    await screen.findByText(/set, ends in ····7890/i);

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await screen.findByPlaceholderText(/paste the token/i);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(await screen.findByText(/set, ends in ····7890/i)).toBeInTheDocument();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("confirms before clearing the token, and clearing also drops the pairing", async () => {
    getStatus.mockResolvedValue({ tokenSet: true, paired: true, pairedName: "Yasam" });
    listSettings.mockResolvedValue([maskedTokenSetting("7890")]);
    renderTelegramTab();
    await screen.findByText(/set, ends in ····7890/i);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(await screen.findByText(/stops responding until a new token/i)).toBeInTheDocument();
    expect(updateSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Clear token" }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ "telegram.botToken": null }));
    await waitFor(() => expect(unpair).toHaveBeenCalled());
  });
});
