import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageTab } from "./StorageTab";
import type { StorageDriverSummary, StorageTestResult } from "@/lib/storage-api";
import type { ResolvedSetting } from "@/lib/settings-api";

afterEach(() => cleanup());

const guide = (title: string) => ({
  title,
  intro: "Read this before turning it on.",
  steps: [
    { text: "Create the bucket." },
    { text: "Paste the endpoint below.", link: "https://example.com/docs" },
    { text: "Attach the policy shown here.", copyValue: "{\"Version\":\"2012-10-17\"}" },
  ],
  notes: ["Nothing here is deleted when you switch away from it."],
});

function localDriver(overrides: Partial<StorageDriverSummary> = {}): StorageDriverSummary {
  return {
    id: "local",
    label: "Local filesystem",
    guide: guide("Store files on this server"),
    configured: true,
    documentCount: 3,
    active: true,
    ...overrides,
  };
}

function s3Driver(overrides: Partial<StorageDriverSummary> = {}): StorageDriverSummary {
  return {
    id: "s3",
    label: "Amazon S3",
    guide: guide("Store files in an S3 compatible bucket"),
    configured: true,
    documentCount: 0,
    active: false,
    ...overrides,
  };
}

function googleDriveDriver(overrides: Partial<StorageDriverSummary> = {}): StorageDriverSummary {
  return {
    id: "googleDrive",
    label: "Google Drive",
    guide: guide("Connect a Google Drive account"),
    configured: false,
    documentCount: 0,
    active: false,
    redirectUri: "http://localhost:4000/api/storage/drivers/googleDrive/callback",
    ...overrides,
  };
}

const googleDriveSettingsUnconfigured: ResolvedSetting[] = [
  { key: "storage.googleDrive.clientId", value: undefined, source: "unset", secret: false, doc: "OAuth client id." },
  { key: "storage.googleDrive.clientSecret", value: { isSet: false }, source: "unset", secret: true, doc: "OAuth client secret." },
  { key: "storage.googleDrive.folderId", value: "", source: "default", secret: false, doc: "Drive folder id." },
];

const googleDriveSettingsReadyToConnect: ResolvedSetting[] = [
  { key: "storage.googleDrive.clientId", value: "cid", source: "db", secret: false, doc: "OAuth client id." },
  { key: "storage.googleDrive.clientSecret", value: { isSet: true, lastFour: "cret" }, source: "db", secret: true, doc: "OAuth client secret." },
  { key: "storage.googleDrive.folderId", value: "", source: "default", secret: false, doc: "Drive folder id." },
];

const googleDriveSettingsConnected: ResolvedSetting[] = [
  ...googleDriveSettingsReadyToConnect,
  { key: "storage.googleDrive.refreshToken", value: { isSet: true, lastFour: "oken" }, source: "db", secret: true, doc: "Refresh token." },
  { key: "storage.googleDrive.accountEmail", value: "someone@example.com", source: "db", secret: false, doc: "Connected account." },
];

const listDrivers = vi.fn(async () => [localDriver(), s3Driver()]);
const testDriver = vi.fn(async (_id: string): Promise<StorageTestResult> => ({ ok: true, message: "Connected." }));
// Annotated rather than inferred: without this the first fixture's literal source
// narrows the mock's type, and a later fixture with a different source stops compiling.
const listSettings = vi.fn(async (): Promise<ResolvedSetting[]> => [
  { key: "storage.local.root", value: "./documents", source: "default", secret: false, doc: "Where files are written." },
  { key: "storage.s3.bucket", value: undefined, source: "unset", secret: false, doc: "Bucket name." },
  { key: "storage.s3.secretAccessKey", value: { isSet: true, lastFour: "9f2a" }, source: "db", secret: true, doc: "Secret key." },
]);
const updateSettings = vi.fn(async (_updates: Record<string, unknown>) => [] as unknown[]);

vi.mock("@/lib/storage-api", () => ({
  storageApi: {
    list: () => listDrivers(),
    test: (id: string) => testDriver(id),
  },
}));

vi.mock("@/lib/settings-api", () => ({
  settingsApi: {
    list: () => listSettings(),
    update: (updates: Record<string, unknown>) => updateSettings(updates),
  },
}));

function renderStorageTab() {
  const queryClient = new QueryClient();
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  const result = render(
    <QueryClientProvider client={queryClient}>
      <StorageTab />
    </QueryClientProvider>,
  );
  return { ...result, invalidateSpy };
}

describe("StorageTab", () => {
  beforeEach(() => {
    listDrivers.mockReset().mockResolvedValue([localDriver(), s3Driver()]);
    testDriver.mockReset().mockResolvedValue({ ok: true, message: "Connected." });
    listSettings.mockClear();
    updateSettings.mockClear();
  });

  it("shows the active driver with its document count, its settings and its guide", async () => {
    renderStorageTab();

    expect(await screen.findByText("Active")).toBeInTheDocument();
    expect(screen.getByText("3 documents")).toBeInTheDocument();
    expect(screen.getByText("0 documents")).toBeInTheDocument();
    expect(screen.getByText("./documents")).toBeInTheDocument();
    expect(screen.getByText("Store files on this server")).toBeInTheDocument();
    // Only the browsed driver's settings show.
    expect(screen.queryByText("Bucket name.")).not.toBeInTheDocument();
  });

  it("browses a different driver without activating it", async () => {
    renderStorageTab();
    await screen.findByText("Active");

    fireEvent.click(screen.getByRole("button", { name: /Amazon S3/i }));

    expect(await screen.findByText("Bucket name.")).toBeInTheDocument();
    expect(screen.getByText("Store files in an S3 compatible bucket")).toBeInTheDocument();
    expect(screen.queryByText("Where files are written.")).not.toBeInTheDocument();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("never renders a secret setting's value into an input", async () => {
    renderStorageTab();
    await screen.findByText("Active");
    fireEvent.click(screen.getByRole("button", { name: /Amazon S3/i }));

    expect(await screen.findByText(/ends in.*9f2a/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    const input = screen.getByPlaceholderText("Paste the value") as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("shows the health check message from the Test button", async () => {
    testDriver.mockResolvedValueOnce({ ok: false, message: "Connection refused." });
    renderStorageTab();
    await screen.findByText("Active");

    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    expect(await screen.findByText("Connection refused.")).toBeInTheDocument();
    expect(testDriver).toHaveBeenCalledWith("local");
  });

  it("asks for confirmation naming both counts before switching storage", async () => {
    renderStorageTab();
    await screen.findByText("Active");
    fireEvent.click(screen.getByRole("button", { name: /Amazon S3/i }));

    fireEvent.click(await screen.findByRole("button", { name: /switch to amazon s3/i }));

    expect(await screen.findByText(/3 documents on Local filesystem will leave the library/i)).toBeInTheDocument();
    expect(screen.getByText(/search and chat keep finding all of them/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Switch storage" }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ "storage.activeDriver": "s3" }));
  });

  it("refetches documents, counts and settings after switching storage, not only the drivers list", async () => {
    const { invalidateSpy } = renderStorageTab();
    await screen.findByText("Active");
    fireEvent.click(screen.getByRole("button", { name: /Amazon S3/i }));
    fireEvent.click(await screen.findByRole("button", { name: /switch to amazon s3/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Switch storage" }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["storage-drivers"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["documents"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["settings"] });
  });

  it("refuses to switch while the driver's health check fails", async () => {
    testDriver.mockResolvedValue({ ok: false, message: "Connection refused." });
    renderStorageTab();
    await screen.findByText("Active");
    fireEvent.click(screen.getByRole("button", { name: /Amazon S3/i }));

    fireEvent.click(await screen.findByRole("button", { name: /switch to amazon s3/i }));

    await screen.findByText("Connection refused.");
    expect(screen.queryByText(/will leave the library/i)).not.toBeInTheDocument();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("disables switching to a driver that is not configured", async () => {
    listDrivers.mockResolvedValue([localDriver(), s3Driver({ configured: false })]);
    renderStorageTab();
    await screen.findByText("Active");
    fireEvent.click(screen.getByRole("button", { name: /Amazon S3/i }));

    expect(await screen.findByRole("button", { name: /switch to amazon s3/i })).toBeDisabled();
  });

  describe("oauth drivers", () => {
    beforeEach(() => {
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    });

    it("shows the exact redirect URI to register, with a copy button", async () => {
      listDrivers.mockResolvedValueOnce([localDriver(), googleDriveDriver()]);
      listSettings.mockResolvedValueOnce(googleDriveSettingsUnconfigured);
      renderStorageTab();
      await screen.findByText("Active");

      fireEvent.click(screen.getByRole("button", { name: /Google Drive/i }));

      expect(await screen.findByText("http://localhost:4000/api/storage/drivers/googleDrive/callback")).toBeInTheDocument();
      expect(screen.getByText(/scheme, host and port must match exactly/i)).toBeInTheDocument();

      const notice = screen.getByText("Redirect URI to register").closest("div") as HTMLElement;
      fireEvent.click(within(notice).getByRole("button", { name: "Copy" }));
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("http://localhost:4000/api/storage/drivers/googleDrive/callback");
    });

    it("offers Connect for an oauth driver that has a client id but no token", async () => {
      listDrivers.mockResolvedValueOnce([localDriver(), googleDriveDriver()]);
      listSettings.mockResolvedValueOnce(googleDriveSettingsReadyToConnect);
      renderStorageTab();
      await screen.findByText("Active");

      fireEvent.click(screen.getByRole("button", { name: /Google Drive/i }));

      const connect = await screen.findByRole("link", { name: "Connect" });
      expect(connect).toHaveAttribute("href", "/api/storage/drivers/googleDrive/connect");
      expect(screen.queryByText(/someone@example.com/)).not.toBeInTheDocument();
    });

    it("does not offer Connect before the client id and secret are saved", async () => {
      listDrivers.mockResolvedValueOnce([localDriver(), googleDriveDriver()]);
      listSettings.mockResolvedValueOnce(googleDriveSettingsUnconfigured);
      renderStorageTab();
      await screen.findByText("Active");

      fireEvent.click(screen.getByRole("button", { name: /Google Drive/i }));

      expect(await screen.findByRole("button", { name: "Connect" })).toBeDisabled();
      expect(screen.queryByRole("link", { name: "Connect" })).not.toBeInTheDocument();
    });

    it("shows the connected account and offers Disconnect once a token exists", async () => {
      listDrivers.mockResolvedValueOnce([localDriver(), googleDriveDriver({ accountEmail: "someone@example.com" })]);
      listSettings.mockResolvedValueOnce(googleDriveSettingsConnected);
      renderStorageTab();
      await screen.findByText("Active");

      fireEvent.click(screen.getByRole("button", { name: /Google Drive/i }));

      expect(await screen.findByText(/someone@example.com/)).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Connect" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
      fireEvent.click(await screen.findByRole("button", { name: "Disconnect Google Drive" }));

      await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
        "storage.googleDrive.refreshToken": null,
        "storage.googleDrive.accountEmail": null,
      }));
    });

    it("hides the local driver's oauth setup entirely", async () => {
      renderStorageTab();
      await screen.findByText("Active");

      expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Connect" })).not.toBeInTheDocument();
      expect(screen.queryByText(/redirect uri/i)).not.toBeInTheDocument();
    });
  });
});
