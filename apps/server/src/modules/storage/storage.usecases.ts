import { basename } from "node:path";
import { createError } from "../../shared/errors/errors.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import { storageDriverRegistry, type StorageDriverId } from "./storage.registry.js";

export function buildStorageKey({ userId, documentId, filename }: { userId: string; documentId: string; filename: string }) {
  const base = basename(filename.replace(/\\/g, "/"));
  const safe = base.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(0, 200) || "file";
  return `${userId}/${documentId}/${safe}`;
}

export function createStorageService({ settingsService }: { settingsService: SettingsService }) {
  return {
    async getDriver(userId: string, driverId: string) {
      const definition = storageDriverRegistry[driverId as StorageDriverId];
      if (!definition) {
        throw createError({ code: "storage.unknown_driver", message: `Unknown storage driver "${driverId}"`, status: 400 });
      }
      return definition.create({ settings: settingsService, userId });
    },
    async getActiveDriverId(userId: string) {
      return (await settingsService.get<StorageDriverId>(userId, "storage.activeDriver")) ?? "local";
    },
    async getActiveDriver(userId: string) {
      return this.getDriver(userId, await this.getActiveDriverId(userId));
    },
  };
}

export type StorageService = ReturnType<typeof createStorageService>;
