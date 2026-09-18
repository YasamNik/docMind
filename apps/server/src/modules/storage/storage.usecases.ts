import { basename } from "node:path";
import { createError } from "../../shared/errors/errors.js";
import type { Database } from "../database/database.js";
import { createDocumentsRepository } from "../documents/documents.repository.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import { storageDriverRegistry, type StorageDriverId } from "./storage.registry.js";
import type { StorageDriverDefinition } from "./storage.types.js";

export function buildStorageKey({
  userId,
  documentId,
  filename,
  uploadedAt,
}: {
  userId: string;
  documentId: string;
  filename: string;
  uploadedAt: Date;
}) {
  const base = basename(filename.replace(/\\/g, "/"));
  const safe = base.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(0, 200) || "file";
  const yyyy = uploadedAt.getUTCFullYear();
  const mm = String(uploadedAt.getUTCMonth() + 1).padStart(2, "0");
  return `${userId}/${yyyy}/${mm}/${documentId}/${safe}`;
}

export function createStorageService({ settingsService, db }: { settingsService: SettingsService; db: Database }) {
  const documentsRepository = createDocumentsRepository({ db });

  // A driver is ready when nothing it cannot invent is missing. Settings that carry a
  // default (prefix, path style) are never the reason a driver is unusable, so only the
  // ones without one are checked.
  async function isConfigured({ definition, userId }: { definition: StorageDriverDefinition; userId: string }) {
    const required = definition.settings.filter((setting) => setting.default === undefined && !setting.internal);
    for (const setting of required) {
      const value = await settingsService.get<unknown>(userId, setting.key);
      if (value === undefined || value === null || value === "") return false;
    }
    return true;
  }

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

    // One call renders the whole picker: what exists, what is ready, what it holds, and
    // the guide that explains the fields.
    async listDriverSummaries(userId: string) {
      const active = await this.getActiveDriverId(userId);
      return Promise.all(
        Object.values(storageDriverRegistry).map(async (definition) => ({
          id: definition.id,
          label: definition.label,
          guide: definition.guide,
          configured: await isConfigured({ definition, userId }),
          documentCount: await documentsRepository.countByUser({ userId, view: "all", storageDriver: definition.id }),
          active: definition.id === active,
        })),
      );
    },

    async testDriver({ userId, driverId }: { userId: string; driverId: string }) {
      return (await this.getDriver(userId, driverId)).healthCheck();
    },
  };
}

export type StorageService = ReturnType<typeof createStorageService>;
