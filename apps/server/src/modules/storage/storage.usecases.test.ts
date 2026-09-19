import { OAuth2Client } from "google-auth-library";
import { describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../shared/test/database.test-utils.js";
import { expectAppError } from "../../shared/test/errors.test-utils.js";
import { createSettingsRegistry } from "../settings/settings.registry.js";
import { createSettingsService } from "../settings/settings.usecases.js";
import { signOAuthState } from "./storage.models.js";
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
    const storage = createStorageService({ settingsService, countDocuments: async () => 0 });
    expect(await storage.getActiveDriverId("u1")).toBe("local");
    const driver = await storage.getActiveDriver("u1");
    expect(driver.id).toBe("local");
    await expectAppError(() => storage.getDriver("u1", "nope"), "storage.unknown_driver");
  });

  it("describeLocation resolves from the definition, never requiring the driver to build", async () => {
    const { db } = await createTestDatabase();
    const settingsService = createSettingsService({
      db,
      registry: createSettingsRegistry(storageSettingDefinitions),
      config: { settingsEncryptionKey: "ab".repeat(32), env: { DOCUMENT_STORAGE_ROOT: "/tmp/docmind-test-root" } },
    });
    const storage = createStorageService({ settingsService, countDocuments: async () => 0 });
    const userId = "u1";
    // No Google Drive connection at all: getDriver must refuse, describeLocation must not.
    await expectAppError(() => storage.getDriver(userId, "googleDrive"), "storage.driver_not_configured");
    expect(await storage.describeLocation(userId, "googleDrive", "1a2b3c")).toEqual({
      label: "Google Drive file 1a2b3c",
      url: "https://drive.google.com/file/d/1a2b3c/view",
    });
    await expectAppError(() => storage.describeLocation(userId, "unknown-driver", "key"), "storage.unknown_driver");
  });

  it("completeOAuthConnection turns a revoked refresh token exchange into a reauth prompt, never a raw error", async () => {
    const { db } = await createTestDatabase();
    const settingsService = createSettingsService({
      db,
      registry: createSettingsRegistry(storageSettingDefinitions),
      config: { settingsEncryptionKey: "ab".repeat(32), env: { DOCUMENT_STORAGE_ROOT: "/tmp/docmind-test-root" } },
    });
    const storage = createStorageService({ settingsService, countDocuments: async () => 0 });
    const userId = "u1";
    await settingsService.set(userId, {
      "storage.googleDrive.clientId": "client-id",
      "storage.googleDrive.clientSecret": "leaked-client-secret",
    });
    const secretHex = "cd".repeat(32);
    const state = signOAuthState({ userId, driverId: "googleDrive", secretHex });

    const getTokenSpy = vi.spyOn(OAuth2Client.prototype, "getToken").mockRejectedValue(
      Object.assign(new Error("invalid_grant"), {
        response: { data: { error: "invalid_grant" } },
        config: { data: new URLSearchParams({ client_secret: "leaked-client-secret" }) },
      }),
    );
    try {
      let caught: unknown;
      try {
        await storage.completeOAuthConnection({ driverId: "googleDrive", code: "bad-code", state, origin: "https://example.com", secretHex });
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string } | undefined)?.code).toBe("storage.reauth_required");
      expect(JSON.stringify(caught)).not.toContain("leaked-client-secret");
    } finally {
      getTokenSpy.mockRestore();
    }
  });
});
