---
name: review-plan-assistant-triage
description: Assistant plan 2 review (2026-09-19), capability registry and triage on feat/email-intake - sound, four concrete fixes, no blocker
metadata:
  type: project
---

Reviewed `docs/superpowers/plans/2026-09-19-assistant-triage.md` on 2026-09-19, branch
`feat/email-intake`, against `docs/superpowers/specs/2026-09-19-assistant-instructions-design.md`
(plan 2 of five). Verdict: ready after fixing four items, none a blocker. See
[[lesson-tool-calling-and-pending-confirmation]] and
[[lesson-runcommand-validation-and-registry-naming]] for the reusable parts.

**What held up well.** The plan is self-aware to an unusual degree: it names its own
residual risks in prose (the reflected-injection channel through the assistant's own
prior replies, the `allowWritingTools` flag being "one flag" away from a confirmation-less
write path) rather than hiding them. Decision 1 (saveNote ships fully but withheld from
the model until plan 3) is a sound, precedented reading of the spec: confirmation guards
an *inference* the model made, not a literal instruction the user typed, and `/note`
already writes immediately today with no regression. Sequencing claims (tree works and is
committable after each task) checked out task by task, including that Task 3 leaves a
fully dead, tested service with no caller and Task 4 explicitly re-verifies the exact
stale-session regression fixed the same morning (72f6f3b).

**The four fixes.**
1. Task 1's own commit gate runs `vitest run chat`, which by filename pattern does not
   include `telegram.usecases.test.ts`, the file holding the one regression test
   (`recovers when the stored chat session was deleted elsewhere`) that the plan's own
   "Watch out" note says depends on `sendMessage`'s reject-before-generator ordering.
   The plan's own "Regression surface" section names this as something to check before
   every commit, but Task 1's literal Step 4 does not run it. Fix: broaden Task 1's test
   run to include telegram, or run the whole server suite before each commit, not just at
   Tasks 3 and 4.
2. `assistant.capabilities.ts` should be `assistant.registry.ts`. The codebase already has
   an established, documented convention for exactly this shape (a plain object keyed by
   id): `settings.registry.ts`, `storage.registry.ts`, `extraction.registry.ts`, called out
   by name in `.claude/rules/server-modules.md`'s "Registries... are plain objects keyed by
   id" line. The plan invents a new suffix for the same concept instead of following it.
3. The plan states "the handler does not parse twice," meaning validation happens once, at
   whichever caller invokes it, not inside `defineCapability`'s wrapper. `runTurn`'s path
   gets this from the AI layer's own `v.safeParse(tool.schema, ...)` inside
   `driveToolCallStream`. `runCommand` is a second caller of the same handlers (the slash
   command path) and the plan never states that it parses `args` against
   `capability.schema` before calling the handler. Without that, a schema-level
   transform (trim, coercion, a future constraint) would apply to a model-chosen call and
   silently not apply to the same tool invoked via slash command, the two paths diverging
   for what is supposed to be one shared handler. Fix: state explicitly that `runCommand`
   validates `args` the same way before dispatch.
4. `recordsTurn` is real and load-bearing for plan 5 (an in-app slash command running
   against a session that already exists, where recording should still be skippable), but
   within plan 2 itself it happens to coincide exactly with "is sessionId null" at all
   three of `runCommand`'s wired call sites (`saveNote`/`startNewThread` get null
   sessionId and `recordsTurn: false`, `searchWeb` gets a real sessionId and
   `recordsTurn: true`). None of the named tests disambiguate the two axes, so a runner
   that branches on `sessionId != null` instead of `capability.recordsTurn` would pass
   every test in this plan while being wrong for plan 5. Fix: add one test with a
   non-null sessionId and a `recordsTurn: false` capability (or the inverse) through
   `runCommand`.

**Verified, not a conflict.** The retry in `driveToolCallStream` (plan 1, already shipped)
appends an assistant-plus-user turn when a tool call's *arguments* fail schema validation,
before any handler ever runs. The spec's "a tool handler produces the reply itself, never
round-trips a result into the messages array" is about a different moment: feeding a
*result* back to get a natural-language reply, which nothing in this plan or the AI layer
does. The plan's own Global Constraints section correctly disambiguates these two turn-append
mechanisms; a reviewer should not conflate them.

**Carried forward to plan 3, not a defect here.** The plan admits, in its "Untrusted
input" section, that the assistant's own prior replies can quote a poisoned document's
text back into the session history that a later triage call reads, a second-hop channel
the single-hop "retrieval never reaches the tool-choosing call" guard does not close.
It is honestly bounded in plan 2 only by the fact that no writing tool is offered to the
model yet. Flagged as a requirement for plan 3: the confirmation surface must show the
literal tool arguments (not just "the assistant wants to write something"), so a human
approving a write can see and reject one driven by a reflected instruction, since that is
exactly what makes propose-then-confirm a real guard against this class of injection
rather than a rubber stamp.
