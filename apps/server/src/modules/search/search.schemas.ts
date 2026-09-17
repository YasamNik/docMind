import * as v from "valibot";

export const embeddingJobPayloadSchema = v.object({
  documentId: v.pipe(v.string(), v.minLength(1)),
  userId: v.pipe(v.string(), v.minLength(1)),
});

export type EmbeddingJobPayloadInput = v.InferOutput<typeof embeddingJobPayloadSchema>;

export const searchQuerySchema = v.object({
  q: v.pipe(v.string(), v.minLength(1)),
  limit: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1), v.maxValue(100))),
});
