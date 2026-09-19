import * as v from "valibot";
import { documentIdSchema } from "../documents/documents.schemas.js";

// The discriminator is deliberately a plain string, like the id below it.
// generateStructured parses the whole reply in one pass and throws on any nested
// failure, so a picklist here would turn one misspelled discriminator into a lost
// reply: every good tag, category, and type decision for that document thrown away.
// Rows whose type is not one of the three known values are dropped after parsing, in
// splitReplyItemsByKnownType, and logged.
export const rulesReplyItemSchema = v.object({
  type: v.string(),
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
  targetType: v.optional(v.picklist(["tag", "category", "type"])),
  targetId: v.optional(v.string()),
});

export const sortScopeSchema = v.pipe(v.string(), v.regex(/^(needs_review|all|category:cat_[0-9a-f]{16})$/, "Invalid scope"));

export const runScopeBodySchema = v.object({
  targetType: v.picklist(["tag", "category", "type"]),
  targetId: v.pipe(v.string(), v.minLength(1)),
  scope: sortScopeSchema,
});

export const scopeQuerySchema = v.object({ scope: sortScopeSchema });

export const dryRunBodySchema = v.object({
  documentId: documentIdSchema,
  targetType: v.picklist(["tag", "category", "type"]),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(60)),
  description: v.pipe(v.string(), v.maxLength(2000)),
  threshold: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
});

export const applyProposalsBodySchema = v.object({
  accept: v.array(v.string()),
  dismiss: v.array(v.string()),
});

export const listProposalsQuerySchema = v.object({
  limit: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1), v.maxValue(200))),
  cursor: v.optional(v.string()),
});

export const ruleSuggestionsSchema = v.object({
  suggestions: v.array(v.object({
    type: v.picklist(["tag", "category"]),
    name: v.pipe(v.string(), v.minLength(1)),
    description: v.pipe(v.string(), v.minLength(1)),
    reasoning: v.pipe(v.string(), v.minLength(1)),
  })),
});
