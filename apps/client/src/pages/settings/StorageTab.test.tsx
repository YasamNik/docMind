import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageTab } from "./StorageTab";
import type { StorageDriverSummary, StorageTestResult } from "@/lib/storage-api";

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

const listDrivers = vi.fn(async () => [localDriver(), s3Driver()]);
const testDriver = vi.fn(async (_id: string): Promise<StorageTestResult> => ({ ok: true, message: "Connected." }));
const listSettings = vi.fn(async () => [
  { key: "storage.local.root", value: "./documents", source: "default" as const, secret: false, doc: "Where files are written." },
  { key: "storage.s3.bucket", value: undefined, source: "unset" as const, secret: false, doc: "Bucket name." },
  { key: "storage.s3.secretAccessKey", value: { isSet: true, lastFour: "9f2a" }, source: "db" as const, secret: true, doc: "Secret key." },
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
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <StorageTab />
    </QueryClientProvider>,
  );
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
});
