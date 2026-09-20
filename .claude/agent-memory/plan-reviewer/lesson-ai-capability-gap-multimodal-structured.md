---
name: lesson-ai-capability-gap-multimodal-structured
description: Check ai.types.ts and both adapters for the exact combination of capabilities a spec assumes (multi-image plus schema-validated structured output) before trusting it exists
metadata:
  type: feedback
---

Extends [[lesson-tool-calling-and-pending-confirmation]]'s pattern (check `AiAdapter` for
real support before trusting a spec's "this already exists") to a second recurring gap:
combined capabilities.

As of 2026-09-20, `apps/server/src/modules/ai/ai.types.ts`'s `AiAdapter` has methods for
each capability alone, never combined:
- `generateStructured({ system, input: string, schema })`: text in, valibot-validated JSON
  out. No image parameter exists on this method at all.
- `recognizeImage({ image: Buffer, mimeType, prompt })`: exactly one image in, freeform
  unstructured `{ text: string }` out. No schema, no array of images.

A spec that wants "several images in one call, structured JSON out" (the family budget
spec's receipt reader, after a redirect from OCR-text to a multi-image vision call) is
asking for a capability that exists in neither adapter today, even though the pieces look
similar: both adapters already build image content-blocks somewhere (inside
`recognizeImage`) and both already build JSON-schema requests somewhere (inside
`generateStructured`), so it looks like "just glue two existing things together." It is
still new, real work: a new `AiAdapter` method (prefer adding one over widening
`generateStructured`'s signature, so the existing summary/rules call sites are untouched,
per CLAUDE.md's "give the new feature its own small copy"), implemented in both
`openai-compatible.adapter.ts` and `anthropic.adapter.ts`, with its own adapter tests
against recorded fixtures per CLAUDE.md's AI-adapter testing rule.

Also check which `ModelSlot` the call should resolve through. `ai.types.ts` already has a
fourth slot, `"vision"`, that DOCMIND-DESIGN.md's "Model slots. Rules, chat, embedding."
paragraph does not mention (stale doc, not a code gap). A call needing both vision and
structured output should resolve through the vision slot and check
`capabilities.vision AND capabilities.structured` together; neither existing capability
check in `ai.usecases.ts` tests that combination, and a provider's vision-slot model is not
guaranteed to also support JSON schema mode (the same reason DESIGN.md already filters the
rules slot's OpenRouter list to `structured_outputs` models, with no equivalent filter on
the vision slot).

**How to apply:** when a spec assumes "the AI layer can already do X plus Y" because it can
do X and can do Y separately, read the actual method signatures in `ai.types.ts` and both
adapter files before accepting the combination as free. Name the new method, which slot it
resolves through, and which capability flags gate it.
