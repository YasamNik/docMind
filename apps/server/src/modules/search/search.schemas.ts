import * as v from "valibot";

export const embeddingJobPayloadSchema = v.object({
  documentId: v.pipe(v.string(), v.minLength(1)),
  userId: v.pipe(v.string(), v.minLength(1)),
});

export type EmbeddingJobPayloadInput = v.InferOutput<typeof embeddingJobPayloadSchema>;
