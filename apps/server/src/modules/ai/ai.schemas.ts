import * as v from "valibot";
import type { ModelSlot } from "./ai.types.js";

export const modelSlotSchema = v.picklist(["rules", "chat", "embedding"] satisfies ModelSlot[]);

export const modelUriSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9_-]+:\/\/.+$/, "Expected format: provider://model"),
);

export const providerIdSchema = v.pipe(v.string(), v.regex(/^[a-z0-9_-]+$/));

export const testProviderParamsSchema = v.object({
  id: providerIdSchema,
});

export const listModelsParamsSchema = v.object({
  id: providerIdSchema,
});
