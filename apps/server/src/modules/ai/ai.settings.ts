import * as v from "valibot";
import { defineSetting } from "../settings/settings.registry.js";
import type { SettingDefinition } from "../settings/settings.types.js";
import { modelUriSchema } from "./ai.schemas.js";

export const aiSlotSettingDefinitions = [
  defineSetting({
    key: "ai.model.rules",
    schema: v.union([modelUriSchema, v.literal("")]),
    env: "AI_MODEL_RULES",
    default: "",
    doc: "Model for sorting rules evaluation. Format: provider://model",
  }),
  defineSetting({
    key: "ai.model.chat",
    schema: v.union([modelUriSchema, v.literal("")]),
    env: "AI_MODEL_CHAT",
    default: "",
    doc: "Model for document chat. Format: provider://model",
  }),
  defineSetting({
    key: "ai.model.embedding",
    schema: v.union([modelUriSchema, v.literal("")]),
    env: "AI_MODEL_EMBEDDING",
    default: "",
    doc: "Model for text embeddings. Format: provider://model",
  }),
];

// Provider settings are collected here, matching the storage pattern:
// storageSettingDefinitions imports storageDriverRegistry and flatMaps its settings.
// The import from providers/index.ts is added by Task 2.
// Until Task 2, this is a placeholder that only has slot settings.
export const aiSettingDefinitions: SettingDefinition[] = [
  ...aiSlotSettingDefinitions,
];
