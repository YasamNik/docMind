import * as v from "valibot";
import { defineSetting } from "../settings/settings.registry.js";
import type { SettingDefinition } from "../settings/settings.types.js";

// Internal, system-bookkeeping setting: never shown on the Settings page, never
// writable through PUT /api/settings. The embedding pipeline records the dimension
// of the currently active embedding model here through settingsService.setInternal(),
// so it can detect a model change (and thus a dimension change) before writing vectors.
export const searchSettingDefinitions: SettingDefinition[] = [
  defineSetting({
    key: "ai.embedding.activeDimension",
    schema: v.number(),
    internal: true,
    default: 0,
    doc: "Dimension of the active embedding model. Set automatically by the embedding pipeline.",
  }),
];
