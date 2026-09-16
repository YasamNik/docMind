import { localDriverDefinition } from "./drivers/local/local.driver.js";
import type { StorageDriverDefinition } from "./storage.types.js";

export const storageDriverRegistry = {
  local: localDriverDefinition,
} as const satisfies Record<string, StorageDriverDefinition>;

export type StorageDriverId = keyof typeof storageDriverRegistry;
export const storageDriverIds = Object.keys(storageDriverRegistry) as StorageDriverId[];
