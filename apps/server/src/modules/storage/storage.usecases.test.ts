import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import { createSettingsRegistry } from "../settings/settings.registry.js";
import { createSettingsService } from "../settings/settings.usecases.js";
import { storageSettingDefinitions } from "./storage.settings.js";
import { buildStorageKey, createStorageService } from "./storage.usecases.js";

describe("storage service", () => {
  it("builds a safe key with the upload year and month from the given date, in UTC", () => {
    const uploadedAt = new Date("2026-03-05T12:00:00.000Z");
    expect(buildStorageKey({ userId: "u1", documentId: "d1", filename: "My Report (final).pdf", uploadedAt })).toBe(
      "u1/2026/03/d1/My_Report_final_.pdf",
    );
    expect(buildStorageKey({ userId: "u1", documentId: "d1", filename: "../../x", uploadedAt })).toBe("u1/2026/03/d1/x");
  });

  it("pads a single-digit month", () => {
    const uploadedAt = new Date("2026-01-09T23:30:00.000Z");
    expect(buildStorageKey({ userId: "u1", documentId: "d1", filename: "a.txt", uploadedAt })).toBe("u1/2026/01/d1/a.txt");
  });

  it("resolves the active driver from settings", async () => {
    const { db } = await createTestDatabase();
    const settingsService = createSettingsService({
      db,
      registry: createSettingsRegistry(storageSettingDefinitions),
      config: { settingsEncryptionKey: "ef".repeat(32), env: { DOCUMENT_STORAGE_ROOT: "/tmp/docmind-test-root" } },
    });
    const storage = createStorageService({ settingsService });
    expect(await storage.getActiveDriverId("u1")).toBe("local");
    const driver = await storage.getActiveDriver("u1");
    expect(driver.id).toBe("local");
    await expectAppError(() => storage.getDriver("u1", "s3"), "storage.unknown_driver");
  });
});
