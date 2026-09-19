import { extractionSettingDefinitions } from "../extraction/extraction.settings.js";
import { storageSettingDefinitions } from "../storage/storage.settings.js";
import { aiSettingDefinitions } from "../ai/ai.settings.js";
import { searchSettingDefinitions } from "../search/search.settings.js";
import { telegramSettingDefinitions } from "../telegram/telegram.settings.js";
import { emailSettingDefinitions } from "../email/email.settings.js";
import type { SettingDefinition } from "./settings.types.js";

export const allSettingDefinitions: SettingDefinition[] = [
  ...storageSettingDefinitions,
  ...extractionSettingDefinitions,
  ...aiSettingDefinitions,
  ...searchSettingDefinitions,
  ...telegramSettingDefinitions,
  ...emailSettingDefinitions,
];
