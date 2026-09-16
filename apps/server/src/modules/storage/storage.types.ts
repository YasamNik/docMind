import type { Readable } from "node:stream";
import type { SettingDefinition } from "../settings/settings.types.js";
import type { SettingsService } from "../settings/settings.usecases.js";

export type StorageDriver = {
  id: string;
  put(args: { key: string; body: Readable; mimeType?: string; sizeBytes?: number }): Promise<{ key: string }>;
  get(args: { key: string }): Promise<Readable>;
  delete(args: { key: string }): Promise<void>;
  exists(args: { key: string }): Promise<boolean>;
  healthCheck(): Promise<{ ok: boolean; message: string }>;
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
