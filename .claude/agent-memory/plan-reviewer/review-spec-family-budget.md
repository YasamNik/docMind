---
name: review-spec-family-budget
description: Review of the family budget design spec (receipt capture, item categories, month view), including a mid-review redirect from OCR-text extraction to a multi-image vision call
metadata:
  type: project
---

Reviewed `docs/superpowers/specs/2026-09-20-family-budget-design.md` on 2026-09-20, under
the CLAUDE.md "DO NOT OVERENGINEER" section added the day before. The review happened in
three passes: the spec as committed (OCR-text extraction), a coordinator redirect mid-review
to a multi-image vision call instead, then a live spike the coordinator ran as evidence
before the final ruling (two real receipt photos, one OpenRouter call to
`google/gemini-2.5-flash`, cost $0.0003, and the model spontaneously refused to merge two
different receipts and said why in a free-text field instead of merging them into a wrong
total).

**Ruling: needs redesign, but narrowly.** The three tables, the duplicate rule, the
reconciliation rule, and the Budget page were all sound and did not need to change. Only
sections 4-5 (how the receipt is read) needed to catch up to the decision already made
mid-conversation, plus one column to cut.

**Blocker: cut `budget_receipts.merchant_category`.** A fixed, code-only enum, a third
categorization system beyond the two the user actually asked for (document categories,
the new item-categories vocabulary). Checked every consumer named in the spec (duplicate
detection uses `merchant`, the month breakdown groups by `item_category_id`); nothing reads
`merchant_category`. Its only touchpoint was being one more editable field on the receipt
screen with no downstream use. Textbook "can I name what breaks if I leave this out" failure.

**Major, verified against the code, not assumed:**
- The spec's own proposed fix for per-page cost ("a document with a parent that belongs to
  a receipt skips summarize and rules") does not work as stated: the receipt row is created
  by a follow-up POST *after* all pages are uploaded, and the job runner polls every 2
  seconds (`jobs.runner.ts`), so a child page's extraction and its rules/summarize/embedding
  enqueues routinely fire before the receipt row exists to look up. See
  [[lesson-upload-then-associate-job-race]].
- Once the redirect landed (multi-image vision call reading raw bytes, not per-page
  `extractedText`), the entire section 5 self-requeue design (`jobs.enqueue` gaining
  `availableAt`, a tries counter, a ten-minute cap, waiting for every page's extraction to
  finish) became unnecessary complexity the redirect itself buys you for free. Flagged for
  deletion from the plan, not a rewrite.
- No AI adapter method combines multiple images with a valibot-validated structured JSON
  reply. `generateStructured` is text-only (`{ system, input: string, schema }`),
  `recognizeImage` is single-image-in-freeform-text-out. This is genuinely new adapter-layer
  work (new method, both adapters, sized as its own task with adapter tests), not glue code.
  See [[lesson-ai-capability-gap-multimodal-structured]].
- The lazy per-user seed flag (`budget.itemCategoriesSeeded`) repeated the exact gap already
  recorded in [[review-spec-document-types]]: "seeded lazily behind a flag" with no stated
  trigger call site. The precedent (`ensureTypesSeeded`, called from inside
  `rules.usecases.ts` right before the sort prompt is built, never at server start) needed
  to be named explicitly for budget's equivalent (inside the receipt job handler, before the
  categorization prompt).

**What held up under scrutiny, stated plainly rather than turned into objections:** no items-
total column, no pages table, no month column, no `budget_id` column (all three "we left this
out" claims verified true against the schema), the two-coffees-same-day duplicate false
positive (pre-approved by the user, cheap to resolve), items-not-summing handling (never
adjust either number, tolerance then flag, Unmatched row), and client-side month summation
on the Budget page (right-sized for a family's realistic receipt volume, not premature
optimization avoidance despite the brief explicitly asking to scrutinize it).

**Process note:** the coordinator ran a live spike against real data mid-review and expected
the ruling to treat that as authoritative over what the spec text said. See
[[feedback-mid-review-redirects-and-live-evidence]].
