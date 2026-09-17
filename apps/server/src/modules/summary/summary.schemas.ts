import * as v from "valibot";

export const summaryReplySchema = v.object({
  summary: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  suggestedTitle: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
});

export const summaryJobPayloadSchema = v.object({
  documentId: v.string(),
  userId: v.string(),
});
