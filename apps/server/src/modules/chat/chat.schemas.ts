import * as v from "valibot";

export const sessionIdSchema = v.pipe(v.string(), v.regex(/^sess_[0-9a-f]{16}$/));

export const createSessionBodySchema = v.object({
  documentScope: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
});

export const sendMessageBodySchema = v.object({
  content: v.pipe(v.string(), v.minLength(1), v.maxLength(10000)),
});
