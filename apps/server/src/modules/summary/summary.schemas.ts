import * as v from "valibot";

export const summaryReplySchema = v.object({
  summary: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  suggestedTitle: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  documentDate: v.nullable(v.pipe(v.string(), v.maxLength(10))),
  // Deliberately `unknown`, not an array of typed rows. generateStructured parses the
  // whole reply in one pass and throws on any nested failure, so anything asserted here
  // can destroy the summary, the title, and the document date along with the fields.
  // That applies to the array's shape as much as to the values inside it: a model that
  // answers `"fields": "none"` or puts a bare string in the array would take the whole
  // reply down. Local models reached through Ollama, LM Studio, or a custom endpoint
  // advertise structured output without any guarantee they honour it, so this is a
  // reachable path, not a hypothetical. normalizeFieldRows does every check instead,
  // including "is this even an array" and "is this element an object", and drops only
  // what is actually wrong. Same discipline as rules.schemas.ts.
  fields: v.optional(v.unknown()),
});

export const summaryJobPayloadSchema = v.object({
  documentId: v.string(),
  userId: v.string(),
});
