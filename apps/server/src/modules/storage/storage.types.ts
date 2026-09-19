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

// The hook an OAuth backed driver fills in so the generic connect and callback routes
// can drive any provider without provider specific routes. The state passed to
// authorizeUrl is opaque to the driver: it is signed and verified in storage.models.ts.
export type StorageOAuth = {
  authorizeUrl(args: { clientId: string; redirectUri: string; state: string }): string;
  exchange(args: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): Promise<{ refreshToken: string; accountEmail: string }>;
  // Which settings hold the credentials, so the routes stay driver agnostic.
  keys: { clientId: string; clientSecret: string; refreshToken: string; accountEmail: string };
};

export type StorageDriverDefinition = {
  id: string;
  label: string;
  settings: SettingDefinition[];
  guide: SetupGuide;
  oauth?: StorageOAuth;
  create(args: { settings: SettingsService; userId: string }): Promise<StorageDriver>;
};
