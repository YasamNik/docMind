import type { Readable } from "node:stream";
import type { SettingDefinition } from "../settings/settings.types.js";
import type { SettingsService } from "../settings/settings.usecases.js";

// Where a file can be found in its own storage, for a user who wants the original
// rather than a download. Synchronous and network free on purpose: the caller is
// usually asking about a driver that is not active and may not be reachable.
export type StorageLocation = { label: string; url?: string };

export type StorageDriver = {
  id: string;
  put(args: { key: string; body: Readable; mimeType?: string; sizeBytes?: number }): Promise<{ key: string }>;
  get(args: { key: string }): Promise<Readable>;
  delete(args: { key: string }): Promise<void>;
  exists(args: { key: string }): Promise<boolean>;
  healthCheck(): Promise<{ ok: boolean; message: string }>;
  describeLocation(args: { key: string }): StorageLocation;
};

export type SetupGuideStep = { text: string; link?: string; copyValue?: string };
export type SetupGuide = { title: string; intro: string; steps: SetupGuideStep[]; notes: string[] };

export type StorageDriverDefinition = {
  id: string;
  label: string;
  settings: SettingDefinition[];
  guide: SetupGuide;
  create(args: { settings: SettingsService; userId: string }): Promise<StorageDriver>;
};
