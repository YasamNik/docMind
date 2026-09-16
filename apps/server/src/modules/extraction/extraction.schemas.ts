import * as v from "valibot";

export const extractionPayloadSchema = v.object({
  documentId: v.pipe(v.string(), v.minLength(1)),
  userId: v.pipe(v.string(), v.minLength(1)),
});

export type ExtractionPayload = v.InferOutput<typeof extractionPayloadSchema>;
