import { googleDriveDriverDefinition } from "./drivers/google-drive/google-drive.driver.js";
import { localDriverDefinition } from "./drivers/local/local.driver.js";
import { s3DriverDefinition } from "./drivers/s3/s3.driver.js";
import type { StorageDriverDefinition } from "./storage.types.js";

export const storageDriverRegistry = {
  local: localDriverDefinition,
  s3: s3DriverDefinition,
  googleDrive: googleDriveDriverDefinition,
} as const satisfies Record<string, StorageDriverDefinition>;

export type StorageDriverId = keyof typeof storageDriverRegistry;
export const storageDriverIds = Object.keys(storageDriverRegistry) as StorageDriverId[];
