import * as v from "valibot";

export const rulesReplyItemSchema = v.object({
  type: v.picklist(["tag", "category"]),
  id: v.string(),
  matched: v.boolean(),
  confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  reasoning: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
});

export const rulesReplySchema = v.object({ items: v.array(rulesReplyItemSchema) });

export const rulesJobPayloadSchema = v.object({
  documentId: v.string(),
  userId: v.string(),
  mode: v.picklist(["initial", "rerun"]),
  targetType: v.optional(v.picklist(["tag", "category"])),
  targetId: v.optional(v.string()),
});
