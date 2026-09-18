import * as v from "valibot";

export const tagIdSchema = v.pipe(v.string(), v.regex(/^tag_[0-9a-f]{16}$/));
export const categoryIdSchema = v.pipe(v.string(), v.regex(/^cat_[0-9a-f]{16}$/));

export const nameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60));
export const colorSchema = v.pipe(v.string(), v.regex(/^#[0-9a-fA-F]{6}$/, "Color must be a hex value like #4f46e5"));
export const tagDescriptionSchema = v.pipe(v.string(), v.maxLength(300));
export const categoryDescriptionSchema = v.pipe(v.string(), v.maxLength(2000));
export const thresholdSchema = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

const nullableColor = v.nullable(colorSchema);

export const createTagBodySchema = v.object({
  name: nameSchema,
  color: v.optional(nullableColor, null),
  description: v.optional(tagDescriptionSchema, ""),
  confidenceThreshold: v.optional(thresholdSchema, 0.7),
  autoApply: v.optional(v.boolean(), true),
});

export const updateTagBodySchema = v.object({
  name: v.optional(nameSchema),
  color: v.optional(nullableColor),
  description: v.optional(tagDescriptionSchema),
  confidenceThreshold: v.optional(thresholdSchema),
  autoApply: v.optional(v.boolean()),
});

export const createCategoryBodySchema = v.object({
  name: nameSchema,
  parentId: v.optional(v.nullable(categoryIdSchema), null),
  color: v.optional(nullableColor, null),
  description: v.optional(categoryDescriptionSchema, ""),
  confidenceThreshold: v.optional(thresholdSchema, 0.7),
  autoApply: v.optional(v.boolean(), true),
});

export const updateCategoryBodySchema = v.object({
  name: v.optional(nameSchema),
  parentId: v.optional(v.nullable(categoryIdSchema)),
  color: v.optional(nullableColor),
  description: v.optional(categoryDescriptionSchema),
  confidenceThreshold: v.optional(thresholdSchema),
  autoApply: v.optional(v.boolean()),
  sortOrder: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

export const documentCategoryBodySchema = v.object({
  categoryId: v.nullable(categoryIdSchema),
});

const reorderEntrySchema = v.object({
  id: categoryIdSchema,
  sortOrder: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export const reorderCategoriesBodySchema = v.object({
  a: reorderEntrySchema,
  b: reorderEntrySchema,
});

export const descriptionAssistantTargetTypeSchema = v.picklist(["tag", "category"]);

export const descriptionAssistantBodySchema = v.object({
  targetType: descriptionAssistantTargetTypeSchema,
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60)),
  description: v.pipe(v.string(), v.maxLength(2000)),
});

// Kept loose deliberately: no maxLength here. generateStructured parses the whole
// reply with one safeParse and throws on any failure, so enforcing the 300 character
// limit in the schema would turn a slightly-too-long answer into a 502 instead of
// something usable. The limit is enforced after parsing, in trimDescriptionSuggestion.
export const descriptionAssistantReplySchema = v.object({
  description: v.string(),
});
