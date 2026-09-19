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

// The envelope chat_sessions.pending_tool_call holds, JSON encoded (assistant
// confirmation plan, Task 2). args is v.unknown() on purpose: the envelope's job is to
// be readable, and only the named tool's own schema knows what valid arguments look
// like, so they are re-parsed against it separately before a handler ever runs.
export const pendingToolCallSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  tool: v.pipe(v.string(), v.minLength(1)),
  args: v.unknown(),
  text: v.pipe(v.string(), v.minLength(1)),
  messageId: v.pipe(v.string(), v.minLength(1)),
  proposedAt: v.pipe(v.string(), v.minLength(1)),
});
