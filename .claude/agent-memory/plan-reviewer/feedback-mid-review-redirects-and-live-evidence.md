---
name: feedback-mid-review-redirects-and-live-evidence
description: The coordinator will interrupt a spec review in progress with a design change and later with live measured evidence; treat both as authoritative over the committed spec text and fold them into one final ruling
metadata:
  type: feedback
---

During the family budget spec review (2026-09-20), the coordinator sent two mid-task
messages after the review was already underway:

1. A direct design change superseding part of the original review brief ("send all shots to
   the LLM in one call at the end" instead of the spec's concatenated-OCR-text approach),
   with instructions to judge the spec against the new design instead of what it currently
   said.
2. A live spike the coordinator ran against real data as evidence before the final ruling
   (two actual receipt photos, one real API call, real cost and token numbers, and a
   real model response showing spontaneous mismatch-refusal behavior), explicitly framed as
   "you are judging a measured thing rather than a proposal."

**Why this matters:** both messages arrived as `SubagentHandback` was not yet called, mid
research. The right response was not to restart the review or ask whether to proceed: it was
to keep the still-valid parts of the original analysis (the three tables, the duplicate
rule, the reconciliation rule, the Budget page, none of which the redirect touched), verify
the new design against the actual code (whether the AI adapter layer could do a multi-image
structured call at all, since that was not yet checked), and treat the live spike's numbers
as settled facts rather than re-litigating them (its cost, feasibility, and observed
mismatch-refusal behavior all became "known," not "to be estimated"). The final report
answered the coordinator's numbered questions from both interruptions explicitly, in order,
before restating the fuller findings.

**How to apply:** when a mid-review course correction or fresh evidence arrives, do not
throw away analysis that the correction did not touch. Re-verify only the parts the
correction actually changes against the real code, fold everything into a single coherent
final ruling, and answer any numbered questions the coordinator asked directly and first,
before the structured Blocker/Major/Minor/Question findings.
