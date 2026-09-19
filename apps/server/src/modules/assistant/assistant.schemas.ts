import * as v from "valibot";

// Shape only: the 8000 character cap is a domain rule, enforced by
// assertInstructionsWithinCap (assistant.models.ts) inside saveInstructions, not here.
// A schema-level v.maxLength would turn an oversize body into a generic "validation"
// error instead of the assistant's own assistant.instructions_too_long sentence.
export const saveInstructionsBodySchema = v.object({
  body: v.string(),
});

export const restoreInstructionsBodySchema = v.object({
  replacedAt: v.pipe(v.string(), v.minLength(1)),
});
