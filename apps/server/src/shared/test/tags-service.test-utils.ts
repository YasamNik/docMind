import type { Database } from "../../modules/database/database.js";
import { createSettingsRegistry } from "../../modules/settings/settings.registry.js";
import { createSettingsService } from "../../modules/settings/settings.usecases.js";
import { tagsSettingDefinitions } from "../../modules/tags/tags.settings.js";
import { createTagsService } from "../../modules/tags/tags.usecases.js";

// createTagsService needs a real settings service for the preset-seeding guard flag
// (types.presetsSeeded). Scoped to the tags module's own definitions, the same way
// documents.usecases.test.ts scopes a settings service to storageSettingDefinitions,
// so a test does not need every setting in the app just to build a tags service.
export function createTestTagsService({ db }: { db: Database }) {
  const settingsService = createSettingsService({
    db,
    registry: createSettingsRegistry(tagsSettingDefinitions),
    config: { settingsEncryptionKey: "99".repeat(32), env: {} },
  });
  return createTagsService({ db, settingsService });
}
