import * as v from "valibot";

export const uploadQuerySchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
});

export const renameBodySchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
});

export const documentIdSchema = v.pipe(v.string(), v.regex(/^doc_[0-9a-f]{16}$/));
