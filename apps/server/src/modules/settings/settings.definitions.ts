import { storageSettingDefinitions } from "../storage/storage.settings.js";
import type { SettingDefinition } from "./settings.types.js";

export const allSettingDefinitions: SettingDefinition[] = [...storageSettingDefinitions];
