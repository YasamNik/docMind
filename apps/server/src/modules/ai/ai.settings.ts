import * as v from "valibot";
import { defineSetting } from "../settings/settings.registry.js";
import type { SettingDefinition } from "../settings/settings.types.js";
import { modelUriSchema } from "./ai.schemas.js";
import { aiProviderIds, aiProviderRegistry } from "./providers/index.js";

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
  defineSetting({
    key: "ai.model.vision",
    schema: v.union([modelUriSchema, v.literal("")]),
    env: "AI_MODEL_VISION",
    default: "",
    doc: "Model for vision-based text extraction from images. Used as a fallback when OCR confidence is low. Format: provider://model",
  }),
];

export const aiVisionSettingDefinitions = [
  defineSetting({
    key: "ai.vision.ocrConfidenceThreshold",
    schema: v.pipe(v.number(), v.minValue(0), v.maxValue(100)),
    env: "AI_VISION_OCR_CONFIDENCE_THRESHOLD",
    default: 60,
    doc: "When Tesseract OCR confidence falls below this value (0-100), the vision model is called as a fallback. Only applies to image documents.",
  }),
];

// One enabled flag per provider. This is the explicit "added" state shown in the AI
// settings tab: the tab shows a card for a provider when this is true, or when the
// provider already has an API key set (the backward compatibility path for providers
// configured before this flag existed). Settings are a plain key/value store, so this
// needs no migration.
export const aiProviderEnabledSettingDefinitions: SettingDefinition[] = aiProviderIds.map((id) =>
  defineSetting({
    key: `ai.${id}.enabled`,
    schema: v.boolean(),
    default: false,
    doc: `Whether the ${aiProviderRegistry[id]!.label} provider card is added in the AI settings tab.`,
  }),
);

// Mirrors the storageSettingDefinitions pattern: import the registry and flatMap its settings.
export const aiSettingDefinitions: SettingDefinition[] = [
  ...aiSlotSettingDefinitions,
  ...aiVisionSettingDefinitions,
  ...aiProviderEnabledSettingDefinitions,
  ...Object.values(aiProviderRegistry).flatMap((d) => d.settings),
];
