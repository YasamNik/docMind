import * as v from "valibot";

// Deliberately loose. generateStructured parses the whole reply as one object and throws
// on any nested failure, so a picklist here would let one invented key destroy the
// summary, the title, and the document date with it. fields.models.ts checks the meaning
// after parsing and drops only the offending row. Same discipline as rules.schemas.ts.
export const summaryFieldRowSchema = v.object({
  key: v.string(),
  value: v.string(),
  currency: v.optional(v.nullable(v.string())),
  confidence: v.optional(v.nullable(v.number())),
});

export const summaryReplySchema = v.object({
  summary: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  suggestedTitle: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  documentDate: v.nullable(v.pipe(v.string(), v.maxLength(10))),
  fields: v.optional(v.array(summaryFieldRowSchema)),
});

export const summaryJobPayloadSchema = v.object({
  documentId: v.string(),
  userId: v.string(),
});
