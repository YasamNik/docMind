import * as v from "valibot";
import { defineSetting } from "../settings/settings.registry.js";
import type { SettingDefinition } from "../settings/settings.types.js";
import { modelUriSchema } from "./ai.schemas.js";
import { aiProviderRegistry } from "./providers/index.js";

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

// Mirrors the storageSettingDefinitions pattern: import the registry and flatMap its settings.
export const aiSettingDefinitions: SettingDefinition[] = [
  ...aiSlotSettingDefinitions,
  ...Object.values(aiProviderRegistry).flatMap((d) => d.settings),
];
