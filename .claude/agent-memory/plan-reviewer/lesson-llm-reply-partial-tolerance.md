---
name: lesson-llm-reply-partial-tolerance
description: How to check a spec that claims per-row tolerance for a structured LLM reply array, since the AI layer validates the whole reply strictly
metadata:
  type: feedback
---

When a spec says an LLM structured-output array should be validated per element ("a bad
row is dropped and logged, it never fails the whole reply"), always check
`apps/server/src/modules/ai/ai.usecases.ts`'s `generateStructured`. It runs one
`v.safeParse(schema, result.data)` against the WHOLE reply schema and throws
`ai.invalid_response` on ANY failure anywhere in the object, including inside a nested
array. There is no valibot-level mechanism in this codebase for "keep the good array
elements, drop the bad ones" during that parse.

**Why this matters**: if the array's item schema uses `v.picklist(...)` or another
strict constraint for a field that is meant to tolerate model mistakes (an id, a key
from a controlled vocabulary, an enum value), one bad element fails the entire reply,
which then fails the entire calling usecase (job goes back to pending, retries, and
after max attempts fails outright) even though the spec's intent was to only drop that
one element. This nearly shipped in the smart fields review (2026-09-18): the fields
array item schema would have naturally been written with a strict `key` enum, which
would have defeated the spec's own "a bad row never fails the summary" guarantee. See
[[review-spec-smart-fields]].

**The existing correct pattern**: `apps/server/src/modules/rules/rules.schemas.ts`
defines `rulesReplyItemSchema.id` as plain `v.string()`, not constrained to real tag or
category ids, specifically so an unrecognized id does not fail the whole parse. The
strictness is applied only where truly free of model-error risk (`type: v.picklist(["tag",
"category"])`, a 2-value structural field). The actual "is this id real" check happens
after parsing, in `rules.usecases.ts` (`findUnknownReplyIds`, then
`.filter((i) => !unknownIds.includes(i.id))`), which drops unknown items and logs a
warning without failing anything.

**How to apply**: whenever reviewing a spec that adds fields to an existing
`generateStructured` reply schema (summary, rules, or any future one) and claims
per-element tolerance, verify the item schema is deliberately loose at the boundary
(plain string/number/nullable, no picklist on the model-error-prone field) and that the
semantic/vocabulary check happens in the module's `*.models.ts` or `*.usecases.ts` after
the parse succeeds, mirroring the rules module. If the spec does not say this
explicitly, flag it as a Blocker: it is not the natural way to write the schema, and a
coder following "controlled vocabulary" language literally will get it wrong.
